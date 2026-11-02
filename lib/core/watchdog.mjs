/**
 * 看门狗：dsh 源码里没有这个东西，所以这里必须先说清楚我们在补什么、凭什么补。
 *
 * 源码事实（三条，都是硬证据）：
 *   1. `wait_agent` 是**被动**观察者：tool-agent-team/lib/index.js L328 的描述原文是
 *      "Wait for the next teammate status, message, or shared-task change **after this call starts**.
 *       This never wakes inactive members and returns noProgress immediately when no other member is
 *       running or provisioning. **Re-list after wakeup or timeout instead of polling.**"
 *      → 它只在有人能产出变化时才等，失败了给的是 noProgress 而不是幻觉式的「还在跑」。
 *   2. 唤醒源是事件，不是轮询：agent-team L1469-1472 `ctx.on("agent/status")` → `activity.notify(id)`，
 *      L158-160 `appendAndFlush` 成功后同步 `onCommit` → notify。
 *   3. 唯一的「掐断」是 `interrupt_agent`，L350 原文 "Interrupt one teammate's current turn while
 *      **preserving its pending inbox**. Team Lead only." → 掐的是**这一轮**，不是这个成员。
 *
 * 缺的是什么：**语义层面的「卡住」**。一个成员可以 status=running（有轮次在执行），
 * 却十分钟不动一行代码、不推进一个 revision。dsh 对此没有任何判定，
 * 因为它把「有没有进展」当成模型自己的责任。
 *
 * 我们补的就是这一层判定，但只输出**一句话**，永远返回 interrupt: false。
 * 掐不掐由人（或队长）决定 —— 这条是设计红线，所以它是返回值里的一个字段，写不死。
 */

export const MINUTE = 60 * 1000;

/** 默认观察窗。短于它不下任何结论（宁可晚报，不可错报）。 */
export const DEFAULT_WINDOW_MS = 6 * MINUTE;

/** 第一个任务的默认宽限：冷启动、拉仓库、装依赖都在这段时间里。 */
export const DEFAULT_GRACE_MS = 10 * MINUTE;

export const VERDICT = Object.freeze({
  OK: "ok",
  UNCLAIMED: "unclaimed",
  SILENT_OWNER: "silent-owner",
  STUCK_REVISION: "stuck-revision",
  UNKNOWN: "unknown",
});

/**
 * 对一个任务下判定。
 *
 * @param {object} q
 * @param {object} q.task        任务视图 {id, status, ownerId, revision}
 * @param {boolean} q.ready      是否就绪（ready-set.isReady）
 * @param {Array<{at: number, revision: number, status: string, ownerActive: boolean}>} q.samples
 *        采样序列，按时间升序。每 30 秒一条，够用且不吵。
 * @param {number} q.now
 * @param {number} [q.windowMs]
 * @param {number} [q.graceMs]   任务创建后多久才开始判定
 * @param {number} [q.createdAt]
 * @returns {{verdict: string, silent: boolean, interrupt: boolean, text: string}}
 *          silent=true 表示「没有值得说的话」，调用方不要打印空话。
 */
export function judge(q) {
  const windowMs = Number.isSafeInteger(q.windowMs) ? q.windowMs : DEFAULT_WINDOW_MS;
  const graceMs = Number.isSafeInteger(q.graceMs) ? q.graceMs : DEFAULT_GRACE_MS;
  const now = Number.isSafeInteger(q.now) ? q.now : Date.now();
  const samples = Array.isArray(q.samples) ? q.samples.filter((s) => Number.isFinite(s?.at)) : [];
  const task = q.task ?? {};
  const id = String(task.id ?? "?");

  const quiet = (verdict, text) => ({ verdict, silent: false, interrupt: false, text });
  const nothing = (verdict, why) => ({ verdict, silent: true, interrupt: false, text: why });

  if (task.status === "completed" || task.status === "deleted") {
    return nothing(VERDICT.OK, "任务已结束");
  }

  // 时间窗不够长，一律不下结论。这一条是上一轮踩过坑之后加的，不许删。
  const span = samples.length >= 2 ? samples[samples.length - 1].at - samples[0].at : 0;
  if (span < windowMs) {
    return nothing(VERDICT.UNKNOWN, `采样只覆盖 ${Math.round(span / MINUTE)} 分钟，不够 ${Math.round(windowMs / MINUTE)} 分钟，不下结论`);
  }

  const createdAt = Number.isFinite(q.createdAt) ? q.createdAt : samples[0].at;
  const age = now - createdAt;
  const head = `任务 ${id}`;

  // 1) 可接但没人接：这是「派活」该发生却没发生的地方，也是最容易被漏掉的一种。
  if (task.status === "pending" && q.ready === true) {
    if (age < graceMs) return nothing(VERDICT.OK, `${head} 刚就绪 ${Math.round(age / MINUTE)} 分钟，还在宽限里`);
    return quiet(
      VERDICT.UNCLAIMED,
      `${head} 已就绪 ${Math.round(age / MINUTE)} 分钟没人接（前置都完成了，写域也没人占）`,
    );
  }

  // 2) 有主，但人不在：in_progress 却所有者的轮次没在执行。
  if (task.status === "in_progress") {
    const owner = task.ownerId === undefined ? "（无主）" : String(task.ownerId);
    const last = samples[samples.length - 1];
    const everActive = samples.some((s) => s.ownerActive === true);

    if (last.ownerActive !== true) {
      const msSinceActive = [...samples].reverse().find((s) => s.ownerActive === true)?.at ?? samples[0].at;
      const idle = now - msSinceActive;
      if (idle < graceMs) return nothing(VERDICT.OK, `${head} 的所有者刚停 ${Math.round(idle / MINUTE)} 分钟，还在宽限里`);
      return quiet(
        VERDICT.SILENT_OWNER,
        `${head} 归 ${owner}，但这个成员已经 ${Math.round(idle / MINUTE)} 分钟没有在执行任何一轮${everActive ? "" : "（从头到尾没见它跑过）"}`,
      );
    }

    // 3) 有主、在跑，但 revision 不动：最贵的失败形态——看着在干活，其实在打转。
    const revisions = samples.map((s) => s.revision);
    const first = revisions[0];
    const changedAt = [...samples].reverse().find((s) => s.revision !== first)?.at;
    const frozenFor = now - (changedAt ?? samples[0].at);
    if (frozenFor >= windowMs) {
      return quiet(
        VERDICT.STUCK_REVISION,
        `${head} 归 ${owner}，成员在跑，但任务已经 ${Math.round(frozenFor / MINUTE)} 分钟停在 revision ${last.revision} 没动过`,
      );
    }
    return nothing(VERDICT.OK, `${head} 正常推进`);
  }

  return nothing(VERDICT.OK, `${head} 状态 ${task.status}，不需要看`);
}

/**
 * 把一批判定压成**一行**。同一类症状只出现一次，绝不刷屏。
 * @param {Array<{verdict: string, silent: boolean, text: string}>} verdicts
 * @returns {string|null}
 */
export function mergeLines(verdicts) {
  const said = verdicts.filter((v) => v && v.silent === false);
  if (said.length === 0) return null;
  const byVerdict = new Map();
  for (const v of said) {
    const bucket = byVerdict.get(v.verdict) ?? [];
    bucket.push(v.text);
    byVerdict.set(v.verdict, bucket);
  }
  const label = {
    [VERDICT.UNCLAIMED]: "🕗 没人接",
    [VERDICT.SILENT_OWNER]: "🕗 人不在了",
    [VERDICT.STUCK_REVISION]: "🌀 在跑但不动",
  };
  return [...byVerdict.entries()]
    .map(([verdict, texts]) => `${label[verdict] ?? "🕗"}：${texts.join("；")}`)
    .join("\n");
}
