/**
 * 审计：每一次机制真正生效，留下一条结构化记录。
 *
 * 为什么要有：dsh 的事件日志记的是**状态**（team/task、team/member、team/message/*），
 * 不记**机制的动作**。看门狗报了一次、派活判定选了「自己干」、开了一棵工作树，
 * 这些都不在 team/* 里。没有这层，任何一个机制都无法回答「它到底有没有拦到东西」，
 * 也就永远无法写出一行诚实的 bench。
 *
 * 格式：JSONL，一行一条，只追加。
 * 字段固定，不许多也不许少 —— 少了没法聚合，多了就是垃圾场。
 */

/**
 * @typedef {object} AuditRecord
 * @property {number} at           毫秒时间戳
 * @property {string} mechanism    authority | ready-set | watchdog | dispatch | worktree
 * @property {string} event        judge | deny | allow | open | close | conflict | advise
 * @property {string} [taskId]
 * @property {string} [subject]    成员名或任务名
 * @property {string} [code]       拒绝码（与 dsh 同码，如 TEAM_TASK_BLOCKED）
 * @property {boolean} [blocked]   这条记录是否代表一次**拦截**（聚合时算比例用）
 * @property {number} [ms]         这一步花了多久（有才写）
 * @property {string} [text]       一句话，人类可读，不截断
 */

const MECHANISMS = new Set(["authority", "ready-set", "watchdog", "dispatch", "worktree"]);
const EVENTS = new Set(["judge", "deny", "allow", "open", "close", "conflict", "advise"]);

/** 组装一条记录；不合法就抛，宁可不写也不写脏的。 */
export function record(fields) {
  const { mechanism, event, text } = fields;
  if (!MECHANISMS.has(mechanism)) throw new Error(`审计记录 mechanism 非法：${mechanism}`);
  if (!EVENTS.has(event)) throw new Error(`审计记录 event 非法：${event}`);
  if (typeof text !== "string" || text.length === 0) throw new Error("审计记录必须有 text");
  const out = {
    at: Number.isFinite(fields.at) ? fields.at : Date.now(),
    mechanism,
    event,
    ...(fields.taskId === undefined ? {} : { taskId: String(fields.taskId) }),
    ...(fields.subject === undefined ? {} : { subject: String(fields.subject) }),
    ...(fields.code === undefined ? {} : { code: String(fields.code) }),
    ...(fields.blocked === undefined ? {} : { blocked: fields.blocked === true }),
    ...(Number.isFinite(fields.ms) ? { ms: Math.round(fields.ms) } : {}),
    text,
  };
  return out;
}

/** 序列化成一行（不带换行符，写的时候加）。 */
export function toLine(rec) {
  return JSON.stringify(rec);
}

/**
 * 聚合一段记录，给 bench 用。
 * @param {string[]} lines
 * @returns {{total: number, byMechanism: Record<string, {total: number, blocked: number}>, blockedRate: number}}
 */
export function summarize(lines) {
  const byMechanism = {};
  let total = 0;
  let blocked = 0;
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (trimmed.length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // 坏行跳过，不让一行损坏毁掉整段统计
    }
    const m = rec?.mechanism ?? "unknown";
    byMechanism[m] ??= { total: 0, blocked: 0 };
    byMechanism[m].total += 1;
    total += 1;
    if (rec?.blocked === true) {
      byMechanism[m].blocked += 1;
      blocked += 1;
    }
  }
  return { total, byMechanism, blockedRate: total === 0 ? 0 : blocked / total };
}
