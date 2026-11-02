/**
 * 权责矩阵：从 dsh 源码抄下来的一份，不是我们发明的。
 *
 * 每一条都对应 `@deepseek-ai/dsh-experimental-agent-team/lib/index.js` 里真实存在的
 * 一个 throw 或一个 if。目的只有一个：用测试锁住「谁能做什么」，
 * 让权限靠代码而不是靠提示词（我们的 D6）。
 *
 * 对应源码位置（0.2.1-alpha.2，lib/index.js）：
 *   L1006  spawnAdmitted:      membership.role !== "lead"      → TEAM_LEAD_REQUIRED
 *   L965   interrupt:          membership.role !== "lead"      → TEAM_LEAD_REQUIRED
 *   L1339  update/reassign:    !lead                          → TEAM_LEAD_REQUIRED
 *   L1282  authorizeOwner():   !lead && !owner                → TEAM_TASK_UNAUTHORIZED
 *   L1288  claim:              ownerId 已属他人                → TEAM_TASK_ALREADY_CLAIMED
 *   L1289  claim:              非 pending 或非 ready            → TEAM_TASK_BLOCKED
 *   L1324  complete:           非 in_progress                  → TEAM_TASK_INVALID_TRANSITION
 *   L1359  delete:             仍有依赖者挂在它下面             → TEAM_TASK_HAS_DEPENDENTS
 *   L1592  send:               target === caller               → TEAM_SELF_MESSAGE
 *
 * 纯函数，无 IO，无状态。
 */

export const ROLE_LEAD = "lead";
export const ROLE_MEMBER = "member";

/** 只有队长能做的动作。源码里这三处是硬 throw，没有任何提示词可以绕过。 */
export const LEAD_ONLY = Object.freeze(["spawn", "interrupt", "reassign"]);

/** 任务所有者或队长能做的动作。 */
export const OWNER_OR_LEAD = Object.freeze([
  "claim",
  "release",
  "edit",
  "set_dependencies",
  "complete",
  "reopen",
  "delete",
]);

/** 任何成员都能做的动作（读 + 给别人发消息）。 */
export const ANY_MEMBER = Object.freeze(["list", "get", "send_message", "wait"]);

export const CODE = Object.freeze({
  LEAD_REQUIRED: "TEAM_LEAD_REQUIRED",
  UNAUTHORIZED: "TEAM_TASK_UNAUTHORIZED",
  ALREADY_CLAIMED: "TEAM_TASK_ALREADY_CLAIMED",
  BLOCKED: "TEAM_TASK_BLOCKED",
  INVALID_TRANSITION: "TEAM_TASK_INVALID_TRANSITION",
  HAS_DEPENDENTS: "TEAM_TASK_HAS_DEPENDENTS",
  SELF_MESSAGE: "TEAM_SELF_MESSAGE",
  OK: "OK",
});

/**
 * 判断一个动作是否被允许。
 *
 * @param {object} q
 * @param {string} q.action  上面三个冻结点集里的任意动作
 * @param {string} q.role    ROLE_LEAD | ROLE_MEMBER
 * @param {boolean} [q.isOwner] 调用者是否是该任务的 owner
 * @param {object} [q.task]  任务视图 {status, ownerId, ready, blockedBy}
 * @param {string} [q.callerId]
 * @param {string} [q.targetId]  仅 send_message 用
 * @param {boolean} [q.targetHasDependents] 仅 delete 用
 * @returns {{allowed: boolean, code: string, reason: string}}
 */
export function canDo(q) {
  const { action, role, isOwner = false } = q;
  const lead = role === ROLE_LEAD;
  const deny = (code, reason) => ({ allowed: false, code, reason });
  const allow = (reason) => ({ allowed: true, code: CODE.OK, reason });

  if (LEAD_ONLY.includes(action)) {
    return lead ? allow(`只有队长能做 ${action}，调用者是队长`) : deny(CODE.LEAD_REQUIRED, `${action} 只有队长能做`);
  }

  if (ANY_MEMBER.includes(action)) {
    if (action === "send_message" && q.callerId !== undefined && q.callerId === q.targetId) {
      return deny(CODE.SELF_MESSAGE, "不能给自己发消息");
    }
    return allow(`${action} 任何成员都能做`);
  }

  if (!OWNER_OR_LEAD.includes(action)) {
    return deny(CODE.INVALID_TRANSITION, `未知动作 ${action}`);
  }

  const task = q.task;

  if (action === "claim") {
    if (task?.ownerId !== undefined && task.ownerId !== q.callerId) {
      return deny(CODE.ALREADY_CLAIMED, "这个任务已经归别人了");
    }
    if (task !== undefined && (task.status !== "pending" || task.ready === false)) {
      return deny(CODE.BLOCKED, `任务状态 ${task.status}${task.ready === false ? "，或前置未完成" : ""}，不能接`);
    }
    return allow("无主且就绪，可以接");
  }

  // 其余动作走 owner 授权，与源码 authorizeOwner() 一致：队长永远可以，成员必须自己是 owner。
  if (!lead && !isOwner) {
    return deny(CODE.UNAUTHORIZED, `${action} 需要任务所有者或队长`);
  }

  if (action === "complete" && task !== undefined && task.status !== "in_progress") {
    return deny(CODE.INVALID_TRANSITION, "只有进行中的任务能标记完成");
  }
  if (action === "delete" && q.targetHasDependents === true) {
    return deny(CODE.HAS_DEPENDENTS, "还有任务挂在它下面，不能删");
  }

  return allow(lead ? "队长放行" : "所有者放行");
}
