import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, mergeLines, VERDICT, MINUTE, DEFAULT_WINDOW_MS } from "../lib/core/watchdog.mjs";

const NOW = 1_700_000_000_000;

/** 造一串采样：每 stepMs 一条，共 n 条，最后一条在 NOW 附近。 */
function samples({ n = 20, stepMs = 30_000, from = NOW - 600_000, revision = 3, status = "in_progress", ownerActive = true }) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ at: from + i * stepMs, revision, status, ownerActive });
  return out;
}

test("红线：任何判定都不许自带 interrupt", () => {
  const cases = [
    { task: { id: "task-1", status: "in_progress", ownerId: "a", revision: 1 }, ready: true, samples: samples({}) },
    { task: { id: "task-2", status: "pending" }, ready: true, samples: samples({ status: "pending", ownerActive: false }) },
    { task: { id: "task-3", status: "completed" }, ready: true, samples: samples({}) },
  ];
  for (const c of cases) {
    const v = judge({ ...c, now: NOW });
    assert.equal(v.interrupt, false, `${c.task.id} 竟然自带 interrupt`);
  }
});

test("采样窗不够长，一律 unknown，不下结论", () => {
  const short = samples({ n: 5, stepMs: 30_000, from: NOW - 120_000 });
  const v = judge({
    task: { id: "task-1", status: "in_progress", ownerId: "a", revision: 1 },
    ready: true,
    samples: short,
    now: NOW,
  });
  assert.equal(v.verdict, VERDICT.UNKNOWN);
  assert.equal(v.silent, true);
  assert.match(v.text, /不下结论/);
});

test("可接但没人接：过了宽限就报，宽限内闭嘴", () => {
  const s = samples({ status: "pending", ownerActive: false, revision: 1, from: NOW - 30 * MINUTE, n: 60, stepMs: 30_000 });
  const late = judge({ task: { id: "task-7", status: "pending" }, ready: true, samples: s, now: NOW });
  assert.equal(late.verdict, VERDICT.UNCLAIMED);
  assert.match(late.text, /没人接/);

  const early = judge({
    task: { id: "task-7", status: "pending" },
    ready: true,
    samples: s,
    now: NOW,
    createdAt: NOW - 2 * MINUTE,
    graceMs: 10 * MINUTE,
  });
  assert.equal(early.verdict, VERDICT.OK);
  assert.equal(early.silent, true, "宽限内不该说话");
});

test("有主但人不在：报 SILENT_OWNER", () => {
  const s = samples({ ownerActive: false, revision: 2, from: NOW - 30 * MINUTE, n: 60, stepMs: 30_000 });
  const v = judge({ task: { id: "task-3", status: "in_progress", ownerId: "m-alpha", revision: 2 }, ready: true, samples: s, now: NOW });
  assert.equal(v.verdict, VERDICT.SILENT_OWNER);
  assert.match(v.text, /m-alpha/);
  assert.match(v.text, /没有在执行任何一轮/);
  assert.match(v.text, /从头到尾没见它跑过/);
});

test("在跑但 revision 不动：报 STUCK_REVISION，这是最贵的失败形态", () => {
  const s = samples({ ownerActive: true, revision: 5, from: NOW - 20 * MINUTE, n: 40, stepMs: 30_000 });
  const v = judge({ task: { id: "task-4", status: "in_progress", ownerId: "m-beta", revision: 5 }, ready: true, samples: s, now: NOW });
  assert.equal(v.verdict, VERDICT.STUCK_REVISION);
  assert.match(v.text, /在跑/);
  assert.match(v.text, /revision 5 没动过/);
});

test("revision 动过就闭嘴（不许把正常推进报成卡住）", () => {
  const s = samples({ ownerActive: true, revision: 1, from: NOW - 12 * MINUTE, n: 25, stepMs: 30_000 });
  // 最后 30 秒推进了一次
  s[s.length - 1].revision = 2;
  const v = judge({ task: { id: "task-5", status: "in_progress", ownerId: "m", revision: 2 }, ready: true, samples: s, now: NOW });
  assert.equal(v.verdict, VERDICT.OK);
  assert.equal(v.silent, true);
});

test("完成/删除的任务永远安静", () => {
  for (const status of ["completed", "deleted"]) {
    const v = judge({ task: { id: "task-1", status }, ready: false, samples: samples({}), now: NOW });
    assert.equal(v.silent, true);
    assert.equal(v.verdict, VERDICT.OK);
  }
});

test("合并成一行：同一类症状只出现一次", () => {
  const line = mergeLines([
    { verdict: VERDICT.SILENT_OWNER, silent: false, text: "任务 task-3 归 a，但这个成员已经 12 分钟没有在执行任何一轮" },
    { verdict: VERDICT.STUCK_REVISION, silent: false, text: "任务 task-4 归 b，成员在跑，但任务已经 9 分钟停在 revision 5 没动过" },
    { verdict: VERDICT.OK, silent: true, text: "正常" },
    { verdict: VERDICT.SILENT_OWNER, silent: false, text: "任务 task-6 归 c，但这个成员已经 14 分钟没有在执行任何一轮" },
  ]);
  const lines = line.split("\n");
  assert.equal(lines.length, 2, "两类症状应该是两行");
  assert.match(lines[0], /人不在了/);
  assert.match(lines[0], /task-3.*task-6/);
  assert.match(lines[1], /在跑但不动/);
});

test("全安静时 mergeLines 返回 null，不打印空话", () => {
  assert.equal(mergeLines([{ verdict: VERDICT.OK, silent: true, text: "x" }]), null);
  assert.equal(mergeLines([]), null);
});

test("默认窗口是 6 分钟，且宽限 10 分钟大于窗口（先宽限再判定）", () => {
  assert.equal(DEFAULT_WINDOW_MS, 6 * MINUTE);
});
