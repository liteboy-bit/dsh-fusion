import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, describe as describeDispatch, VERDICT } from "../lib/core/dispatch.mjs";
import { branchFor, worktreePath, planWorktree, checkScope } from "../lib/core/task-worktree.mjs";
import { record, toLine, summarize } from "../lib/core/audit.mjs";

/* ---------------- dispatch ---------------- */

test("切不开就自己干（一块活）", () => {
  const d = decide([{ subject: "改 watchdog", writeScopes: ["lib/core/watchdog.mjs"], verifiable: true }]);
  assert.equal(d.verdict, VERDICT.SELF);
  assert.match(d.reason, /切不开/);
  assert.deepEqual(d.cost, { messages: 0, waits: 0 });
});

test("写域有重叠就自己干：切了也要串行，没有并行收益", () => {
  const d = decide([
    { subject: "A", writeScopes: ["lib/core"], verifiable: true },
    { subject: "B", writeScopes: ["lib/core/watchdog.mjs"], verifiable: true },
  ]);
  assert.equal(d.verdict, VERDICT.SELF);
  assert.match(d.reason, /写同一批文件/);
});

test("有块不能独立验收就自己干：交出去等于丢控制权", () => {
  const d = decide([
    { subject: "A", writeScopes: ["docs"], verifiable: true },
    { subject: "B", writeScopes: ["public"], verifiable: false },
  ]);
  assert.equal(d.verdict, VERDICT.SELF);
  assert.match(d.reason, /独立验收判据/);
  assert.match(d.reason, /B/);
});

test("依赖链深 > 1 就自己干：分出去只多一次往返", () => {
  const d = decide([
    { subject: "A", writeScopes: ["a"], verifiable: true },
    { subject: "B", writeScopes: ["b"], verifiable: true, blockedBy: ["1"] },
    { subject: "C", writeScopes: ["c"], verifiable: true, blockedBy: ["2"] },
  ]);
  assert.equal(d.verdict, VERDICT.SELF);
  assert.match(d.reason, /依赖链深 2 层/);
});

test("真的切得开才分，并且把往返成本报出来", () => {
  const d = decide([
    { subject: "A", writeScopes: ["lib"], verifiable: true },
    { subject: "B", writeScopes: ["docs"], verifiable: true },
    { subject: "C", writeScopes: ["test"], verifiable: true },
  ]);
  assert.equal(d.verdict, VERDICT.DELEGATE);
  assert.deepEqual(d.cost, { messages: 3, waits: 1 });
  assert.match(describeDispatch(d), /往返成本：3 条消息 \+ 1 次等待/);
});

test("判定里不出现「必须派发」这类纪律措辞", () => {
  const d = decide([{ subject: "A", writeScopes: ["x"], verifiable: true }]);
  assert.doesNotMatch(describeDispatch(d), /必须|应当|任务要求你/);
});

/* ---------------- task-worktree ---------------- */

test("分支名只认 task-<n>，不接受临时名字", () => {
  assert.equal(branchFor({ id: "task-12" }), "task/task-12");
  assert.throws(() => branchFor({ id: "fix-bug" }), /不是 task-<数字>/);
  assert.throws(() => branchFor({ id: "task-x" }), /不是 task-<数字>/);
});

test("工作树落点与 dsh 默认目录一致，且只认自己管辖的分支", () => {
  assert.equal(worktreePath("task/task-7"), ".agents/worktrees/task-task-7");
  assert.throws(() => worktreePath("feature/x"), /不在本服务管辖范围/);
});

test("只读任务不开树（开了会读到和别人不一样的内容）", () => {
  const p = planWorktree({ id: "task-2", ownerId: "m1", writeScopes: [] });
  assert.equal(p.open, false);
  assert.match(p.reason, /只读任务/);
});

test("没人接的任务不开树（开早了没人用）", () => {
  const p = planWorktree({ id: "task-3", writeScopes: ["lib"] });
  assert.equal(p.open, false);
  assert.match(p.reason, /还没人接/);
});

test("要改文件且有人接才开树，带分支和路径", () => {
  const p = planWorktree({ id: "task-4", ownerId: "m2", writeScopes: ["lib/core"] });
  assert.equal(p.open, true);
  assert.equal(p.branch, "task/task-4");
  assert.equal(p.path, ".agents/worktrees/task-task-4");
  assert.match(p.reason, /lib\/core/);
});

test("越界检查：advisory 升级成可判定，越界路径要列出来", () => {
  const task = { id: "task-5", writeScopes: ["lib/core"] };
  const ok = checkScope(task, ["lib/core/watchdog.mjs", "lib/core/authority.mjs"]);
  assert.equal(ok.ok, true);
  assert.match(ok.text, /全在声明的写域内/);

  const bad = checkScope(task, ["lib/core/x.mjs", "server.mjs", "docs/a.md"]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.outside, ["server.mjs", "docs/a.md"]);
  assert.match(bad.text, /越界 2 个/);

  const noScope = checkScope({ id: "task-6", writeScopes: [] }, ["a.mjs"]);
  assert.equal(noScope.ok, false);
  assert.match(noScope.text, /任务没声明写域，却改了 1 个文件/);
});

test("Windows 反斜杠写域也能判", () => {
  const r = checkScope({ id: "task-8", writeScopes: ["lib\\core"] }, ["lib\\core\\a.mjs"]);
  assert.equal(r.ok, true);
});

/* ---------------- audit ---------------- */

test("审计记录字段固定：非法机制/事件/空文本直接抛，不让脏数据进库", () => {
  assert.throws(() => record({ mechanism: "magic", event: "judge", text: "x" }), /mechanism 非法/);
  assert.throws(() => record({ mechanism: "watchdog", event: "boil", text: "x" }), /event 非法/);
  assert.throws(() => record({ mechanism: "watchdog", event: "judge", text: "" }), /必须有 text/);
});

test("一条记录能序列化回来，且只带必要字段", () => {
  const rec = record({ mechanism: "authority", event: "deny", taskId: "task-3", subject: "m-alpha", code: "TEAM_TASK_UNAUTHORIZED", blocked: true, text: "不是 owner 也不是队长" });
  const line = toLine(rec);
  assert.equal(line.includes("\n"), false);
  const back = JSON.parse(line);
  assert.equal(back.mechanism, "authority");
  assert.equal(back.blocked, true);
  assert.equal(back.code, "TEAM_TASK_UNAUTHORIZED");
  assert.equal(back.ms, undefined, "没给 ms 就不该出现");
});

test("聚合：坏行跳过，拦截率按记录算", () => {
  const lines = [
    toLine(record({ mechanism: "authority", event: "deny", blocked: true, text: "拦了" })),
    toLine(record({ mechanism: "authority", event: "allow", blocked: false, text: "放了" })),
    toLine(record({ mechanism: "watchdog", event: "advise", blocked: false, text: "提醒了" })),
    "{ 这不是 json",
    "",
  ];
  const s = summarize(lines);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byMechanism.authority, { total: 2, blocked: 1 });
  assert.deepEqual(s.byMechanism.watchdog, { total: 1, blocked: 0 });
  assert.equal(Math.round(s.blockedRate * 100), 33);
});
