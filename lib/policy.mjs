/**
 * 系统提示里那一段。
 *
 * 为什么要这一段：四个只读工具注册了不等于会被用。dsh 的模型只看得到工具的
 * name/description，看不到「什么时候该问」；实测里模型会把它们当装饰。
 * 这一段只有五条、全部是「什么时候调」的触发条件，没有一条要求它改变行为——
 * 因为这套东西的定位是**给人和模型同一份事实**，不是替谁做决定。
 *
 * 语言用英文，与 dsh 自带的 TEAM_POLICY 保持一致（同一段提示里混语言会稀释指令）。
 */

/** 段落名。与 dsh 的 `team:policy` 并列，不重名。 */
export const POLICY_SECTION_NAME = "fusion:policy";

export const POLICY = `Fusion board — read-only checks. They report; they never change state.

- Inside an agent team, or before you accept/split work, call fusion_board once: it returns what is ready, which write scopes collide, and candidate owners. Do not restate it as an assignment.
- When you are deciding whether a piece of work is yours or should be delegated, call fusion_plan with the parts (subject, write scopes, dependencies, whether each part is independently verifiable). It returns a verdict plus the round-trip cost, and never dispatches.
- When you are unsure whether your role may perform an action, call fusion_can. Its answer mirrors the harness's own hard checks, not a suggestion.
- Before opening an isolated worktree, or before committing, call fusion_worktree_hint: it returns the branch, the path, and whether your changed paths leave the task's write scope.
- These tools never spawn, never interrupt, and never mutate task state. Never wait on them to act on your behalf.`;
