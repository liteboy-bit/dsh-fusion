/** core 层门面：纯函数、无 IO、无 ctx。外部只用这里。 */
export { canDo, CODE, ROLE_LEAD, ROLE_MEMBER, LEAD_ONLY, OWNER_OR_LEAD, ANY_MEMBER } from "./authority.mjs";
export { normalizeTask, isReady, readySet, scopesOverlap, conflictMap, candidatesFor, describeBoard } from "./ready-set.mjs";
export { judge, mergeLines, VERDICT as WATCHDOG_VERDICT, DEFAULT_WINDOW_MS, DEFAULT_GRACE_MS, MINUTE } from "./watchdog.mjs";
export { decide, describe as describeDispatch, VERDICT as DISPATCH_VERDICT } from "./dispatch.mjs";
export { branchFor, worktreePath, planWorktree, checkScope } from "./task-worktree.mjs";
export { record, toLine, summarize } from "./audit.mjs";
