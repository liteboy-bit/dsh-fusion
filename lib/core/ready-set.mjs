/**
 * ready-set：Router 的替代品。
 *
 * 结论先说：dsh 里没有 Router 这个角色，也不该有。
 * 路由在 dsh 源码里是**数据**，不是**人**：
 *
 *   - 任务是否能被接手，由 `taskReady()` 一个纯函数算出来：
 *     agent-team/lib/index.js L354 `task.blockedBy.every(id => 该任务 status === "completed")`
 *   - 谁能接，由 `claim` 的 CAS 决定：L1288-1295 检查「无主 + pending + ready」，然后写 ownerId
 *   - 任务撞车，由 `projectTaskView` 算重叠警告：L345 `scopesOverlap()` + L369-372
 *     注意它自己的措辞是 **advisory, not a lock**（tool-agent-team POLICY L23）
 *
 * 所以「派活」这个动作在 dsh 里根本不存在：没有人把任务交出去，
 * 任务只是从「不可接」变成「可接」，然后某个成员自己 claim。
 * 队长唯一保留的例外路径是 `reassign`（L1338-1355），它需要的是**队长权限**，
 * 不是**队长义务**——这是「不强制派发」的代码证据。
 *
 * 本模块把这套推导抽成纯函数，供看门狗和审计读；它永远不执行派发。
 */

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {"pending"|"in_progress"|"completed"|"deleted"} status
 * @property {string[]} blockedBy
 * @property {string[]} writeScopes
 * @property {string} [ownerId]
 * @property {number} [revision]
 */

/** 把一个任务归一化，容忍缺字段（板子是从投影里读来的，字段可能不全）。 */
export function normalizeTask(task) {
  return {
    id: String(task?.id ?? ""),
    status: task?.status ?? "pending",
    blockedBy: Array.isArray(task?.blockedBy) ? task.blockedBy.map(String) : [],
    writeScopes: Array.isArray(task?.writeScopes) ? task.writeScopes.map(String) : [],
    ...(task?.ownerId === undefined ? {} : { ownerId: task.ownerId }),
    revision: Number.isSafeInteger(task?.revision) ? task.revision : 0,
  };
}

/** 与源码 L354 一致：所有前置都 completed 才算就绪。缺前置视为未完成。 */
export function isReady(tasks, task) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.blockedBy.every((id) => byId.get(id)?.status === "completed");
}

/**
 * 当前可接手的任务集合。不做排序、不做分配、不挑人。
 * @param {Task[]} tasks
 * @returns {Task[]}
 */
export function readySet(tasks) {
  const list = (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter((t) => t.status !== "deleted");
  return list.filter((t) => t.status === "pending" && t.ownerId === undefined && isReady(list, t));
}

/** 与源码 L345 一致：按路径分量判断包含关系，不是字符串前缀匹配。 */
export function scopesOverlap(left, right) {
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * 仍在进行中的任务之间的写域冲突。源码措辞是 advisory（L23 POLICY、L383 writeScopeWarnings），
 * 我们保留「警告」语义，但在下一层（task-worktree）把它变成「隔离」。
 * @param {Task[]} tasks
 * @returns {Array<{a: string, b: string, scopes: [string, string]}>}
 */
export function conflictMap(tasks) {
  const active = (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter((t) => t.status === "in_progress");
  const out = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      for (const left of a.writeScopes) {
        for (const right of b.writeScopes) {
          if (scopesOverlap(left, right)) out.push({ a: a.id, b: b.id, scopes: [left, right] });
        }
      }
    }
  }
  return out;
}

/**
 * 「谁能接这个任务」——只给候选，不给指派。
 *
 * 判据两条，都来自源码事实：
 *   1. 写域不与任何进行中任务重叠（L371 的重叠规则，这里升级成硬过滤）
 *   2. 任务声明的写域落在该成员的能力域内（dsh 没有这个概念，见 docs/RATIONALE.md §5 的空缺）
 *
 * @param {Task} task
 * @param {Task[]} allTasks
 * @param {Array<{name: string, caps?: string[]}>} members
 * @returns {Array<{name: string, why: string}>}
 */
export function candidatesFor(task, allTasks, members) {
  const t = normalizeTask(task);
  const busyScopes = allTasks
    .map(normalizeTask)
    .filter((x) => x.status === "in_progress" && x.id !== t.id)
    .flatMap((x) => x.writeScopes);

  const out = [];
  for (const m of members) {
    const caps = Array.isArray(m?.caps) ? m.caps : [];
    const clash = t.writeScopes.filter((s) => busyScopes.some((b) => scopesOverlap(s, b)));
    if (clash.length > 0) {
      out.push({ name: m.name, why: `写域撞车（${clash.join(", ")}），不建议接` });
      continue;
    }
    if (t.writeScopes.length > 0 && caps.length > 0) {
      const ok = t.writeScopes.every((s) => caps.some((c) => scopesOverlap(s, c)));
      if (!ok) {
        out.push({ name: m.name, why: `能力域不覆盖 ${t.writeScopes.join(", ")}` });
        continue;
      }
    }
    out.push({ name: m.name, why: "写域空闲且能力覆盖" });
  }
  return out;
}

/**
 * 一行人类可读的板子状态。用户可见文本不截断（我们的规矩），也不出现「分派」字样。
 * @param {Task[]} tasks
 * @returns {string}
 */
export function describeBoard(tasks) {
  const list = (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter((t) => t.status !== "deleted");
  const ready = readySet(list);
  const running = list.filter((t) => t.status === "in_progress");
  const done = list.filter((t) => t.status === "completed");
  const parts = [`共 ${list.length} 个任务：完成 ${done.length}、进行中 ${running.length}、可接 ${ready.length}`];
  if (ready.length > 0) parts.push(`可接：${ready.map((t) => t.id).join(", ")}`);
  const conflicts = conflictMap(list);
  if (conflicts.length > 0) {
    parts.push(`写域撞车 ${conflicts.length} 处：${conflicts.map((c) => `${c.a}×${c.b}(${c.scopes.join(" / ")})`).join("；")}`);
  }
  return parts.join("；");
}
