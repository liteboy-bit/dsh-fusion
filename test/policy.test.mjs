import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { POLICY, POLICY_SECTION_NAME } from "../lib/policy.mjs";

const LEAD = { id: "root-1", options: { model: "x" } };

/** 最小可用的假 ctx：只实现 apply() 真的碰到的几个面。 */
function fakeCtx({ withPrompt = true, promptThrows = false } = {}) {
  const sections = [];
  const disposers = [];
  const logs = [];
  const memberships = new Map([[LEAD, { id: "team-1", name: "lead", root: LEAD }]]);
  const services = new Map([
    [
      "agentTeams",
      {
        tryMembership: (agent) => memberships.get(agent),
        listRoots: () => [LEAD],
        listTasks: () => [],
        listMembers: () => [{ id: "root-1", name: "lead", status: "running" }],
      },
    ],
    ["tools", { register: () => () => {} }],
  ]);
  if (withPrompt) {
    services.set("systemPrompt", {
      getSectionOrder: (key) => {
        assert.equal(key, "TEAM_POLICY", "段落号必须借用已有的 TEAM_POLICY 槽位");
        return 600;
      },
      section: (section) => {
        if (promptThrows) throw new Error("boom");
        sections.push(section);
        return () => {};
      },
    });
  }
  return {
    get: (name) => services.get(name),
    effect: (fn) => {
      const d = fn();
      disposers.push(d);
      return d;
    },
    emit: () => undefined,
    logger: { info: (...args) => logs.push(args.join(" ")) },
    _sections: sections,
    _logs: logs,
    _dispose: () => disposers.forEach((d) => typeof d === "function" && d()),
  };
}

test("提示段：五条触发条件里点名四个工具，且没有一条要求它行动", () => {
  for (const tool of ["fusion_board", "fusion_can", "fusion_plan", "fusion_worktree_hint"]) {
    assert.match(POLICY, new RegExp(tool), `提示里必须提到 ${tool}`);
  }
  // 只读承诺必须在正文里，不能只写在代码注释里。
  assert.match(POLICY, /never spawn/);
  assert.match(POLICY, /never interrupt/);
  assert.match(POLICY, /never mutate/);
  // 不许出现「你去派发 / 你去改状态」这类越权指令。
  assert.doesNotMatch(POLICY, /dispatch the task|assign it|interrupt the|mark (it|the task) (as )?(done|complete)/i);
});

test("提示段：长度受控，占的是 TEAM_POLICY 槽位", () => {
  const lines = POLICY.split("\n").filter((l) => l.trim() !== "");
  assert.ok(lines.length <= 12, `提示段 ${lines.length} 行，太长会稀释指令`);
  const ctx = fakeCtx();
  apply(ctx, { sampleMs: 60_000 });
  assert.equal(ctx._sections.length, 1);
  assert.equal(ctx._sections[0].name, POLICY_SECTION_NAME);
  assert.equal(ctx._sections[0].order, 600);
  assert.equal(ctx._sections[0].text, POLICY);
  ctx._dispose();
});

test("提示段：advise: false 时一个字都不进提示", () => {
  const ctx = fakeCtx();
  apply(ctx, { advise: false, sampleMs: 60_000 });
  assert.equal(ctx._sections.length, 0);
  ctx._dispose();
});

test("提示段：没有 systemPrompt 服务时照常激活，只是少了提示", () => {
  const ctx = fakeCtx({ withPrompt: false });
  apply(ctx, { sampleMs: 60_000 });
  assert.equal(ctx._sections.length, 0);
  ctx._dispose();
});

test("提示段：注册抛错不打死插件，只留一行日志", () => {
  const ctx = fakeCtx({ promptThrows: true });
  assert.doesNotThrow(() => apply(ctx, { sampleMs: 60_000 }));
  assert.ok(
    ctx._logs.some((line) => line.includes("提示未接线")),
    "失败必须说出来，不许静默",
  );
  ctx._dispose();
});
