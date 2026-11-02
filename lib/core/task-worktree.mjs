/**
 * 一个任务 = 一个 git 工作树。
 *
 * 源码事实：dsh 已经有这个原语，叫 `worktrees`：
 *   dsh-experimental-worktree/lib/index.js
 *   - L178 类注释："Creates a new Git branch and checkout, then **changes the calling Session's
 *     working directory**"
 *   - L193 默认落点 `.agents/worktrees`，分支前缀 `worktree-`
 *   - L24  工作树池目录写 `.gitignore` 内容为 `*`（自忽略，不进主仓）
 *   - L286  分支已存在 → 直接失败，不静默复用
 *   - L297  目录已存在 → 直接失败
 *   - L357  成功后 `workingDirectory.set(agent, path)` —— 换掉这个 session 的 cwd
 *   - L108  清掉 GIT_DIR / GIT_INDEX_FILE 等 16 个继承变量，避免「以为在子仓其实在主仓」
 *   - L263  `core.hooksPath=/dev/null`、`core.fsmonitor=false`，L352 `reset --hard`
 *
 * 也就是说「任务=仓库」在 dsh 里是现成插件，缺的是**绑定**：
 * 任务板上的 writeScopes 是 advisory（tool-agent-team POLICY L23 明说 "not a lock"），
 * 没有任何一行代码逼着 owner 在自己的工作树里干活。
 *
 * 本模块只做绑定推导：从任务视图算出该不该开树、开在哪、基线是什么、越界了怎么判。
 * 真正的 git 调用交给 dsh 的 worktrees 服务，我们不重写。
 */

/** 分支名必须是合法 ref 段：小写 kebab，可带 / ，不许中文和空格。 */
export function branchFor(task) {
  const id = String(task?.id ?? "").trim();
  if (!/^task-\d+$/.test(id)) throw new Error(`任务 id ${JSON.stringify(id)} 不是 task-<数字>，无法映射成分支`);
  return `task/${id}`;
}

/** 工作树落点，与 dsh 默认目录一致，避免两套约定。 */
export function worktreePath(branch, directory = ".agents/worktrees") {
  if (!/^task\/task-\d+$/.test(branch)) throw new Error(`分支 ${branch} 不在本服务管辖范围（只认 task/task-<n>）`);
  return `${directory}/${branch.replace("/", "-")}`;
}

/**
 * 该不该为这个任务开工作树。
 *
 * 判据：只有**会改文件**的任务才需要树。只读任务（调研、审查）开树是浪费，
 * 而且会让它的 cwd 和别人的不一致，读到的内容不一样。
 *
 * @param {object} task {id, status, ownerId, writeScopes}
 * @returns {{open: boolean, reason: string, branch?: string, path?: string}}
 */
export function planWorktree(task) {
  const scopes = Array.isArray(task?.writeScopes) ? task.writeScopes : [];
  const owner = task?.ownerId ?? task?.ownerName; // dsh 的视图叫 ownerName，内部叫 ownerId
  if (scopes.length === 0) {
    return { open: false, reason: "任务没声明写域，是只读任务，开工作树只会让它读到和别人不一样的文件" };
  }
  if (owner === undefined) {
    return { open: false, reason: "任务还没人接，等 claim 之后再开树（开早了没人用）" };
  }
  const branch = branchFor(task);
  return { open: true, reason: `要改 ${scopes.join(", ")}，开独立工作树，互不覆盖`, branch, path: worktreePath(branch) };
}

/**
 * 提交前检查：这次改动有没有越出任务声明的写域。
 * dsh 是 advisory（只警告），这里升级成**可判定**，因为它同时被审计行记录。
 *
 * @param {object} task
 * @param {string[]} changedPaths  本次改动涉及的路径（相对仓库根）
 * @returns {{ok: boolean, outside: string[], text: string}}
 */
export function checkScope(task, changedPaths) {
  const scopes = Array.isArray(task?.writeScopes) ? task.writeScopes.map((s) => s.replaceAll("\\", "/")) : [];
  const changed = (Array.isArray(changedPaths) ? changedPaths : []).map((p) => p.replaceAll("\\", "/"));
  if (scopes.length === 0) {
    return { ok: changed.length === 0, outside: changed, text: changed.length === 0 ? "没有改动" : `任务没声明写域，却改了 ${changed.length} 个文件` };
  }
  const outside = changed.filter((p) => !scopes.some((s) => p === s || p.startsWith(`${s}/`)));
  return {
    ok: outside.length === 0,
    outside,
    text: outside.length === 0 ? `改动 ${changed.length} 个文件，全在声明的写域内` : `越界 ${outside.length} 个：${outside.join(", ")}`,
  };
}
