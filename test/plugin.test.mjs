import { test } from "node:test";
import assert from "node:assert/strict";
import { name, inject, Config, apply, internals } from "../lib/index.js";

const LEAD = { id: "root-1", options: { model: "x" } };

/** 最小可用的假 ctx：只实现插件真正碰到的几个面。 */
function fakeCtx({ tasks = [], members = [], roots = [LEAD], withTools = true } = {}) {
  const tools = new Map();
  const disposers = [];
  const emitted = [];
  const memberships = new Map(roots.map((a) => [a, { id: "team-1", name: "lead", root: a }]));
  const agentTeams = {
    tryMembership: (agent) => memberships.get(agent),
    listenRoots: () => roots,
    listRoots: () => roots,
    listTasks: () => tasks,
    listMembers: () => [{ id: "root-1", name: "lead", status: "running" }, ...members],
  };
  const services = new Map([["agentTeams", agentTeams]]);
  if (withTools) {
    services.set("tools", { register: (def) => (tools.set(def.name, def), () => tools.delete(def.name)) });
  }
  return {
    get: (service) => services.get(service),
    /*
     * 忠实复刻 cordis 的 Context 代理：没在 inject 里声明就直读 `ctx.tools` 是抛错，
     * 不是 undefined。留着这个 getter 是为了防止代码被人改回直读。
     */
    get tools() {
      throw new Error('cannot get property "tools" without inject');
    },
    effect: (fn) => {
      const d = fn();
      disposers.push(d);
      return d;
    },
    emit: (event, payload) => (emitted.push({ event, payload }), undefined),
    logger: { info: () => {} },
    agentTeams,
    _tools: tools,
    _emitted: emitted,
    _services: services,
    _dispose: () => disposers.forEach((d) => typeof d === "function" && d()),
  };
}

test("插件形状：名字、硬依赖、配置、apply", () => {
  assert.equal(name, "dsh-fusion");
  assert.deepEqual(inject, ["agentTeams"]);
  assert.deepEqual(Object.keys(Config), ["~standard"]);
  assert.equal(typeof Config["~standard"].validate, "function");
  assert.equal(typeof apply, "function");
});

test("注册的都是只读工具，一个能改状态的都没有", () => {
  const ctx = fakeCtx();
  apply(ctx, { sampleMs: 60_000 });
  const names = [...ctx._tools.keys()].sort();
  assert.deepEqual(names, ["fusion_board", "fusion_can", "fusion_plan", "fusion_worktree_hint"]);
  for (const n of names) {
    assert.doesNotMatch(n, /spawn|interrupt|reassign|kill|cancel|delete|write|apply/, `${n} 不该是可变更动作`);
  }
  ctx._dispose();
});

test("tools: false 时不注册任何工具，但仍装 tick", () => {
  const ctx = fakeCtx();
  apply(ctx, { tools: false, sampleMs: 60_000 });
  assert.equal(ctx._tools.size, 0);
  ctx._dispose();
});

test("没有 tools 服务时照样激活：少四个查询工具，不是整台机器倒下", () => {
  const ctx = fakeCtx({ withTools: false });
  assert.doesNotThrow(() => apply(ctx, { sampleMs: 60_000 }));
  assert.equal(ctx._tools.size, 0);
  ctx._dispose();
});

test("fusion_board 在没有任务时也返回一句话，不崩", async () => {
  const ctx = fakeCtx();
  apply(ctx, { sampleMs: 60_000 });
  const out = await ctx._tools.get("fusion_board").execute({}, { agent: LEAD });
  assert.equal(out.text, "共 0 个任务：完成 0、进行中 0、可接 0");
  assert.deepEqual(out.ready, []);
  assert.deepEqual(out.conflicts, []);
  ctx._dispose();
});

test("fusion_can：成员问 reassign，得到 LEAD_REQUIRED；队长问同一条，放行", async () => {
  const member = { id: "m-1", options: {} };
  const ctx = fakeCtx({ members: [{ id: "m-1", name: "beta", status: "running" }] });
  ctx.agentTeams.tryMembership = (agent) =>
    agent === LEAD ? { id: "team-1", name: "lead", root: LEAD } : agent === member ? { id: "team-1", name: "beta", root: LEAD } : undefined;
  apply(ctx, { sampleMs: 60_000 });
  const can = ctx._tools.get("fusion_can");

  const asMember = await can.execute({ action: "reassign" }, { agent: member });
  assert.equal(asMember.allowed, false);
  assert.equal(asMember.code, internals.CODE.LEAD_REQUIRED);

  const asLead = await can.execute({ action: "reassign" }, { agent: LEAD });
  assert.equal(asLead.allowed, true);

  const outsider = await can.execute({ action: "list" }, { agent: { id: "nobody" } });
  assert.equal(outsider.code, "TEAM_NOT_MEMBER");
  ctx._dispose();
});

test("fusion_plan：一块活 → 自己干；三块不相交 → 分出去并报成本", async () => {
  const ctx = fakeCtx();
  apply(ctx, { sampleMs: 60_000 });
  const plan = ctx._tools.get("fusion_plan");

  const one = await plan.execute({ parts: [{ subject: "A", write_scopes: ["lib"], verifiable: true }] });
  assert.equal(one.verdict, "self");
  assert.deepEqual(one.cost, { messages: 0, waits: 0 });

  const three = await plan.execute({
    parts: [
      { subject: "A", write_scopes: ["lib"], verifiable: true },
      { subject: "B", write_scopes: ["docs"], verifiable: true },
      { subject: "C", write_scopes: ["test"], verifiable: true },
    ],
  });
  assert.equal(three.verdict, "delegate");
  assert.deepEqual(three.cost, { messages: 3, waits: 1 });
  ctx._dispose();
});

test("fusion_worktree_hint：只读任务不开树，给了改动路径才判越界", async () => {
  const tasks = [
    { id: "task-1", status: "in_progress", ownerName: "beta", revision: 2, ready: true, writeScopes: ["lib/core"] },
    { id: "task-2", status: "pending", revision: 1, ready: true, writeScopes: [] },
  ];
  const ctx = fakeCtx({ tasks });
  apply(ctx, { sampleMs: 60_000 });
  const hint = ctx._tools.get("fusion_worktree_hint");

  const ro = await hint.execute({ task_id: "task-2" }, { agent: LEAD });
  assert.equal(ro.plan.open, false);
  assert.match(ro.plan.reason, /只读任务/);

  const withChanged = await hint.execute({ task_id: "task-1", changed_paths: ["lib/core/a.mjs", "server.mjs"] }, { agent: LEAD });
  assert.equal(withChanged.plan.open, true);
  assert.equal(withChanged.plan.branch, "task/task-1");
  assert.deepEqual(withChanged.scope.outside, ["server.mjs"]);

  const missing = await hint.execute({ task_id: "task-99" }, { agent: LEAD });
  assert.equal(missing.found, false);
  ctx._dispose();
});

test("watchdog tick 在没有任何任务时什么都不发（不许刷空话）", async () => {
  const t = fakeCtx();
  apply(t, { sampleMs: 30 });
  await new Promise((r) => setTimeout(r, 100));
  t._dispose();
  assert.equal(t._emitted.filter((e) => e.event === "fusion/advice").length, 0);
});

test("采样窗不足时，即使板子上有表现异常的任务也不提示", async () => {
  const tasks = [{ id: "task-1", status: "in_progress", ownerName: "beta", revision: 3, ready: true, writeScopes: ["lib"] }];
  const t = fakeCtx({ tasks, members: [{ id: "m-1", name: "beta", status: "running" }] });
  apply(t, { sampleMs: 20, windowMs: 6 * 60 * 1000 });
  await new Promise((r) => setTimeout(r, 150));
  t._dispose();
  const advice = t._emitted.filter((e) => e.event === "fusion/advice");
  assert.equal(advice.length, 0, `窗口不够长却报了：${JSON.stringify(advice)}`);
});
