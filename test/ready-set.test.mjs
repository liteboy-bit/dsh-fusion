import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTask, isReady, readySet, scopesOverlap, conflictMap, candidatesFor, describeBoard,
} from "../lib/core/ready-set.mjs";

const T = (id, extra = {}) => normalizeTask({ id, status: "pending", blockedBy: [], writeScopes: [], ...extra });

test("就绪 = 所有前置 completed；缺前置算未完成（与源码 L354 一致）", () => {
  const a = T("task-1", { status: "completed" });
  const ghost = T("task-9");
  assert.equal(isReady([a], T("task-2", { blockedBy: ["task-1"] })), true);
  assert.equal(isReady([a], T("task-2", { blockedBy: ["task-9"] })), false, "前置不存在时不能算就绪");
  assert.equal(isReady([ghost], T("task-2", { blockedBy: ["task-9"] })), false, "前置是 pending 时不能算就绪");
});

test("readySet 只收「无主 + pending + 就绪」，不做排序不做挑选", () => {
  const tasks = [
    T("task-1", { status: "completed" }),
    T("task-2", { blockedBy: ["task-1"], writeScopes: ["lib/a"] }),
    T("task-3", { status: "in_progress", ownerId: "m1" }),
    T("task-4", { blockedBy: ["task-3"] }),
    T("task-5", { status: "pending", ownerId: "m2" }),
  ];
  const ready = readySet(tasks);
  assert.deepEqual(ready.map((t) => t.id), ["task-2"], "只有 task-2 该就绪");
});

test("写域重叠按路径分量算，不是字符串前缀", () => {
  assert.equal(scopesOverlap("lib/a", "lib/a"), true);
  assert.equal(scopesOverlap("lib/a", "lib/a/b.mjs"), true);
  assert.equal(scopesOverlap("lib/ab", "lib/a"), false, "lib/ab 不属于 lib/a");
  assert.equal(scopesOverlap("lib", "public"), false);
});

test("冲突只在进行中的任务之间算，完成的不算", () => {
  const tasks = [
    T("task-1", { status: "in_progress", ownerId: "a", writeScopes: ["lib/core"] }),
    T("task-2", { status: "in_progress", ownerId: "b", writeScopes: ["lib/core/watchdog.mjs"] }),
    T("task-3", { status: "completed", writeScopes: ["lib/core"] }),
  ];
  const c = conflictMap(tasks);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].a, c[0].b], ["task-1", "task-2"]);
  assert.deepEqual(c[0].scopes, ["lib/core", "lib/core/watchdog.mjs"]);
});

test("候选人不指派：撞车的写进 why，能力不覆盖的写进 why，都不静默丢掉", () => {
  const all = [T("task-1", { status: "in_progress", ownerId: "a", writeScopes: ["lib/core"] })];
  const task = T("task-2", { writeScopes: ["lib/core/watchdog.mjs"] });
  const out = candidatesFor(task, all, [
    { name: "alpha", caps: ["lib/core"] },
    { name: "beta", caps: ["public"] },
  ]);
  assert.equal(out.length, 2);
  assert.match(out[0].why, /写域撞车/);
  assert.match(out[1].why, /能力域不覆盖|写域撞车/);
});

test("没人占的时候能力覆盖就能接", () => {
  const task = T("task-2", { writeScopes: ["docs"] });
  const out = candidatesFor(task, [], [{ name: "alpha", caps: ["docs"] }]);
  assert.deepEqual(out, [{ name: "alpha", why: "写域空闲且能力覆盖" }]);
});

test("describeBoard 一行说清，不出现「分派」字样", () => {
  const tasks = [
    T("task-1", { status: "completed" }),
    T("task-2", { status: "in_progress", ownerId: "a", writeScopes: ["lib"] }),
    T("task-3", { status: "in_progress", ownerId: "b", writeScopes: ["lib/x"] }),
    T("task-4", { writeScopes: ["docs"] }),
  ];
  const line = describeBoard(tasks);
  assert.match(line, /共 4 个任务：完成 1、进行中 2、可接 1/);
  assert.match(line, /可接：task-4/);
  assert.match(line, /写域撞车 1 处/);
  assert.doesNotMatch(line, /分派|指派|派活/);
});

test("空板子也不崩", () => {
  assert.equal(describeBoard([]), "共 0 个任务：完成 0、进行中 0、可接 0");
  assert.deepEqual(readySet(undefined), []);
});
