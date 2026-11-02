import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canDo, CODE, ROLE_LEAD, ROLE_MEMBER, LEAD_ONLY, OWNER_OR_LEAD, ANY_MEMBER,
} from "../lib/core/authority.mjs";

test("队长专属动作：成员一定被拦，且用的是 dsh 自己的错误码", () => {
  for (const action of LEAD_ONLY) {
    const r = canDo({ action, role: ROLE_MEMBER });
    assert.equal(r.allowed, false, `${action} 不该允许成员`);
    assert.equal(r.code, CODE.LEAD_REQUIRED);
    const lead = canDo({ action, role: ROLE_LEAD });
    assert.equal(lead.allowed, true, `${action} 队长应该能做`);
  }
});

test("成员动别人的任务：拦，码是 TEAM_TASK_UNAUTHORIZED", () => {
  for (const action of OWNER_OR_LEAD) {
    if (action === "claim") continue;
    const r = canDo({ action, role: ROLE_MEMBER, isOwner: false, task: { status: "in_progress" } });
    assert.equal(r.allowed, false, `${action} 不该允许非 owner`);
    assert.equal(r.code, CODE.UNAUTHORIZED);
  }
});

test("成员动自己的任务：放行（这是唯一的越权入口，必须开）", () => {
  const r = canDo({ action: "complete", role: ROLE_MEMBER, isOwner: true, task: { status: "in_progress" } });
  assert.equal(r.allowed, true);
  assert.equal(r.code, CODE.OK);
});

test("claim：别人已占 → ALREADY_CLAIMED；前置没完成 → BLOCKED", () => {
  const taken = canDo({ action: "claim", role: ROLE_MEMBER, callerId: "b", task: { status: "pending", ownerId: "a", ready: true } });
  assert.equal(taken.code, CODE.ALREADY_CLAIMED);

  const blocked = canDo({ action: "claim", role: ROLE_MEMBER, task: { status: "pending", ready: false } });
  assert.equal(blocked.code, CODE.BLOCKED);
  assert.match(blocked.reason, /前置未完成/);

  const ok = canDo({ action: "claim", role: ROLE_MEMBER, callerId: "b", task: { status: "pending", ready: true } });
  assert.equal(ok.allowed, true);
});

test("complete 只能对进行中的任务", () => {
  const r = canDo({ action: "complete", role: ROLE_MEMBER, isOwner: true, task: { status: "pending" } });
  assert.equal(r.code, CODE.INVALID_TRANSITION);
});

test("delete：还有依赖者挂着就拦", () => {
  const r = canDo({ action: "delete", role: ROLE_LEAD, task: { status: "pending" }, targetHasDependents: true });
  assert.equal(r.allowed, false);
  assert.equal(r.code, CODE.HAS_DEPENDENTS);
});

test("send_message 不许发给自己", () => {
  const r = canDo({ action: "send_message", role: ROLE_MEMBER, callerId: "x", targetId: "x" });
  assert.equal(r.code, CODE.SELF_MESSAGE);
  const ok = canDo({ action: "send_message", role: ROLE_MEMBER, callerId: "x", targetId: "lead" });
  assert.equal(ok.allowed, true);
});

test("读操作谁都能做", () => {
  for (const action of ANY_MEMBER) {
    if (action === "send_message") continue;
    assert.equal(canDo({ action, role: ROLE_MEMBER }).allowed, true, action);
  }
});

test("未知动作不静默放行", () => {
  const r = canDo({ action: "promote_self", role: ROLE_LEAD });
  assert.equal(r.allowed, false);
  assert.equal(r.code, CODE.INVALID_TRANSITION);
});

test("矩阵是冻结的：三个集合互不重叠、无遗漏", () => {
  const all = [...LEAD_ONLY, ...OWNER_OR_LEAD, ...ANY_MEMBER];
  assert.equal(new Set(all).size, all.length, "三个集合有重叠");
  assert.deepEqual(
    [...all].sort(),
    ["claim", "complete", "delete", "edit", "get", "interrupt", "list", "reassign", "release", "reopen", "send_message", "set_dependencies", "spawn", "wait"],
  );
});
