/**
 * 派不派活：把它当成本题，不当纪律题。
 *
 * 你指出的毛病是真的：「队长很多时候就能独立把任务完成，我们还要求他去分发」。
 * 这在 dsh 源码里根本不是义务。证据：
 *
 *   - `reassign` 是唯一带「把活交出去」语义的动作，L1339 只写了 `if (!lead) throw`，
 *     没有反过来要求 lead 必须 reassign。**队长有权限，没义务。**
 *   - 什么都没人接的时候，`wait_agent` 不等，直接回 noProgress：
 *     tool-agent-team L338-344，message 原文是
 *     "No other Team member is running or provisioning. wait_agent cannot make progress or wake
 *      inactive teammates. Re-list ... then use send_message to wake each required inactive teammate."
 *     注意它给的是**你的选择**，不是「你必须派发」。
 *   - 所以 dsh 的态度是：一个人能干完就干完，需要第二个人时才叫第二个人。
 *
 * 我们的问题在于把「派发」做成了流程里的一步，于是它必然发生，也必然浪费。
 * 这个模块把它降级成一个判定：**只有能切成不相交写域、且每一块都能独立验收时才值得派**。
 *
 * 纯函数，返回判定和代价，不执行任何动作。
 */

/**
 * @typedef {object} Plan
 * @property {string} subject
 * @property {string[]} writeScopes   这块活要改的路径
 * @property {string[]} [blockedBy]   依赖的其他块 id
 * @property {boolean} [verifiable]   能不能独立验收（有明确判据）
 */

export const VERDICT = Object.freeze({
  SELF: "self",
  DELEGATE: "delegate",
});

function overlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * 决定自己干还是分出去。
 *
 * 四条判据，任一不满足就自己干（保守优先，因为派发的代价是真实且立刻发生的）：
 *   1. 能切成 >= 2 块
 *   2. 任意两块写域不相交（有重叠就必须串行，串行没有并行收益）
 *   3. 每块都能独立验收（不能验收的块交出去等于丢掉控制权）
 *   4. 依赖链深度 <= 1（有链式依赖时分出去只会多一次往返）
 *
 * @param {Plan[]} plans
 * @returns {{verdict: string, parts: Plan[], reason: string, cost: {messages: number, waits: number}}}
 */
export function decide(plans) {
  const parts = (Array.isArray(plans) ? plans : []).map((p) => ({
    subject: String(p?.subject ?? ""),
    writeScopes: Array.isArray(p?.writeScopes) ? p.writeScopes.map(String) : [],
    blockedBy: Array.isArray(p?.blockedBy) ? p.blockedBy.map(String) : [],
    verifiable: p?.verifiable === true,
  }));

  const self = (reason) => ({ verdict: VERDICT.SELF, parts: [], reason, cost: { messages: 0, waits: 0 } });

  if (parts.length < 2) return self("只有一块活，切不开");

  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const clash = parts[i].writeScopes.filter((a) => parts[j].writeScopes.some((b) => overlap(a, b)));
      if (clash.length > 0) {
        return self(`第 ${i + 1} 块和第 ${j + 1} 块写同一批文件（${clash.join(", ")}），切了也要串行`);
      }
    }
  }

  const unverifiable = parts.filter((p) => p.verifiable !== true);
  if (unverifiable.length > 0) {
    return self(`有 ${unverifiable.length} 块没有独立验收判据（${unverifiable.map((p) => p.subject).join("、")}），交出去就丢了控制权`);
  }

  const depth = chainDepth(parts);
  if (depth > 1) return self(`依赖链深 ${depth} 层，分出去只多一次往返`);

  return {
    verdict: VERDICT.DELEGATE,
    parts,
    reason: `切成 ${parts.length} 块互不相交、各自可验收的活，值得分出去`,
    // 每块一次 send_message，然后一次 wait_agent 收全部。往返次数是成本，必须报出来。
    cost: { messages: parts.length, waits: 1 },
  };
}

/** 依赖链最长深度。0 表示谁都不等谁。 */
function chainDepth(parts) {
  const byId = new Map(parts.map((p, i) => [String(i + 1), p]));
  const bySubject = new Map(parts.map((p) => [p.subject, p]));
  const depthOf = (p, seen = new Set()) => {
    if (seen.has(p.subject)) return 0;
    seen.add(p.subject);
    if (p.blockedBy.length === 0) return 0;
    let max = 0;
    for (const id of p.blockedBy) {
      const dep = byId.get(id) ?? bySubject.get(id);
      if (dep === undefined) continue;
      max = Math.max(max, 1 + depthOf(dep, seen));
    }
    return max;
  };
  return parts.reduce((acc, p) => Math.max(acc, depthOf(p)), 0);
}

/**
 * 一行人类可读的判定说明。
 * @param {ReturnType<typeof decide>} d
 * @returns {string}
 */
export function describe(d) {
  if (d.verdict === VERDICT.SELF) return `自己干：${d.reason}`;
  return `分出去：${d.reason}（往返成本：${d.cost.messages} 条消息 + ${d.cost.waits} 次等待）`;
}
