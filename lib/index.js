/**
 * dsh-fusion 的 cordis 插件入口。
 *
 * 这一层只做「接线」，不做判定。判定全在 lib/core/*.mjs 里，纯函数、可单测、不碰 ctx。
 * 这样即使 dsh 内部 seam 改名，坏掉的也只是接线，判定和测试还在。
 *
 * 接线用到的 seam（全部来自源码，不是猜的）：
 *   ctx.tools.register(...)                与 dsh-experimental-tool-agent-team/lib/index.js L236 同款
 *   ctx.effect(fn, label)                  与 dsh-experimental-agent-team/lib/index.js L1473 同款
 *   ctx.on("agent/created" | "agent/status")  同款，L1466 / L1469
 *   ctx.agentTeams.listTasks / listMembers / tryMembership   L1546 / L1498 / L826
 *
 * 设计原则：本插件**默认只读**。它注册的是「观察 + 提示」，不注册 spawn / interrupt，
 * 也不自动开工作树。要写文件、要掐轮次，仍然必须走 dsh 自己的工具（人来做决定）。
 */

import { canDo, CODE, LEAD_ONLY, OWNER_OR_LEAD, ANY_MEMBER, ROLE_LEAD, ROLE_MEMBER } from "./core/authority.mjs";
import { readySet, conflictMap, describeBoard, candidatesFor } from "./core/ready-set.mjs";
import { judge, mergeLines } from "./core/watchdog.mjs";
import { decide, describe as describeDispatch } from "./core/dispatch.mjs";
import { planWorktree, checkScope } from "./core/task-worktree.mjs";
import { record, toLine, summarize } from "./core/audit.mjs";
import { defineTools } from "./tools.mjs";
import { POLICY, POLICY_SECTION_NAME } from "./policy.mjs";

export const name = "dsh-fusion";

/** agentTeams 是硬依赖：没有它就没有板子可看。 */
export const inject = ["agentTeams"];

export { Config } from "./config.mjs";
import { normalizeConfig } from "./config.mjs";
import { trace } from "./lab-trace.mjs";

/**
 * @param {any} ctx cordis Context
 * @param {unknown} config
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);

  const log = (...args) => {
    // logger 不是硬依赖，也不值得为它让 entry 挂掉：读不到就当没日志。
    try {
      const logger = ctx.logger;
      if (logger && typeof logger.info === "function") logger.info("[fusion]", ...args);
    } catch {
      /* 静默：日志丢了不构成故障 */
    }
  };

  // 一行开机自述：既告诉人这套东西真的挂上了，也让热重载看得见（每次重载都会再打一次）。
  log(
    `已接线｜观察窗 ${Math.round(cfg.windowMs / 60000)} 分钟｜采样 ${Math.round(cfg.sampleMs / 1000)} 秒｜` +
      `只读工具${cfg.tools ? "开" : "关"}｜提示${cfg.advise ? "开" : "关"}（只建议，从不替你停人）`,
  );

  /** 成员名归一：dsh 用 "lead" 表示根 session。 */
  const roleOf = (agent) => {
    const m = ctx.agentTeams.tryMembership(agent);
    if (m === undefined) return undefined;
    return { role: m.name === "lead" ? ROLE_LEAD : ROLE_MEMBER, name: m.name };
  };

  const allTasks = (agent) => {
    try {
      return ctx.agentTeams.listTasks(agent) ?? [];
    } catch {
      return [];
    }
  };

  const allMembers = (agent) => {
    try {
      return ctx.agentTeams.listMembers(agent) ?? [];
    } catch {
      return [];
    }
  };

  /* ---------- 只读工具：把人需要的一句话做成工具，而不是塞进系统提示 ---------- */

  /*
   * ctx.tools 是「要求 inject 才能取」的属性：没声明 inject 就直接读会抛
   * `cannot get property "tools" without inject`（cordis 的 Context 代理）。
   * 但 tools 是**可选**能力——没有它这台机器只是少了四个查询工具，板子和审计照旧。
   * 所以走 ctx.get("tools")：缺了给 undefined，不抛。硬依赖只有 agentTeams。
   */
  const tools = typeof ctx.get === "function" ? ctx.get("tools") : undefined;

  // 探索期见证：设了 DSH_FUSION_TRACE 才有 IO，否则完全关闭。
  trace({ event: "apply", cfg, hasTools: Boolean(tools), at: Date.now() });

  /*
   * 工具接线：一个注册不上，等于少一个查询入口；板子、审计、提示照旧。
   * 逐个 try/catch 是刻意的——不许一个工具把整个 entry 打死，
   * 也不许它默默消失（失败进日志和 trace，带名字带原因）。
   */
  const registered = [];
  const registerTool = (def) => {
    try {
      ctx.effect(() => tools.register(def), `fusion.${def.name}()`);
      registered.push(def.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`工具未注册：${def.name}｜${message}`);
      trace({ event: "tool-failed", tool: def.name, error: message, at: Date.now() });
    }
  };

  if (cfg.tools && tools && typeof tools.register === "function") {
    for (const def of defineTools({ allTasks, allMembers, roleOf })) registerTool(def);
  }

  /*
   * 系统提示那一段：工具注册了不等于会被用。
   * `systemPrompt` 同样是可选服务（走 ctx.get，不声明 inject），缺了就只是「模型不知道什么时候问」。
   * 段落号借用 TEAM_POLICY（600），和团队策略挨着，出现在工具说明之前。
   */
  const systemPrompt = typeof ctx.get === "function" ? ctx.get("systemPrompt") : undefined;
  if (cfg.advise && systemPrompt && typeof systemPrompt.section === "function") {
    try {
      ctx.effect(
        () =>
          systemPrompt.section({
            name: POLICY_SECTION_NAME,
            order: systemPrompt.getSectionOrder("TEAM_POLICY"),
            text: POLICY,
          }),
        "fusion.policy()",
      );
      registered.push(POLICY_SECTION_NAME);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`提示未接线：${message}`);
      trace({ event: "policy-failed", error: message, at: Date.now() });
    }
  }

  /* ---------- 只读观察：每 30 秒采一次，判一次，最多说一行 ---------- */

  const samples = new Map(); // taskId -> Array<{at, revision, status, ownerActive}>
  const created = new Map(); // taskId -> 第一次见到它的时间
  const announced = new Map(); // taskId -> 上一次说过的 verdict（不重复念同一句）

  /** 根 session：roster 里那条 "lead" 行指向的 session。 */
  function rootAgent() {
    try {
      const seen = new Set();
      for (const agent of ctx.agentTeams?.listRoots?.() ?? []) {
        const m = ctx.agentTeams.tryMembership(agent);
        if (m !== undefined && !seen.has(m.id)) {
          seen.add(m.id);
          return m.root ?? agent;
        }
      }
    } catch {
      /* 拿不到就返回 undefined，sweep 会安静跳过 */
    }
    return undefined;
  }

  function writeAudit(rec) {
    if (typeof ctx.emit !== "function") return;
    try {
      ctx.emit("fusion/audit", { line: toLine(rec) });
    } catch {
      /* 审计写不进去也不许影响主流程 */
    }
  }

  const sweep = () => {
    const now = Date.now();
    const root = rootAgent();
    if (root === undefined) return;

    const tasks = allTasks(root);
    const activeNames = new Set(allMembers(root).filter((m) => m.status === "running").map((m) => m.name));
    const verdicts = [];

    for (const task of tasks) {
      if (task.status === "completed" || task.status === "deleted") {
        samples.delete(task.id);
        created.delete(task.id);
        announced.delete(task.id);
        continue;
      }
      if (!created.has(task.id)) created.set(task.id, now);
      const series = samples.get(task.id) ?? [];
      series.push({
        at: now,
        revision: task.revision,
        status: task.status,
        ownerActive: task.ownerName === undefined ? false : activeNames.has(task.ownerName),
      });
      // 只留最近 2 小时，别把内存吃穿
      while (series.length > 0 && now - series[0].at > 2 * 60 * 60 * 1000) series.shift();
      samples.set(task.id, series);

      const v = judge({
        task: { id: task.id, status: task.status, ownerId: task.ownerName, revision: task.revision },
        ready: task.ready,
        samples: series,
        now,
        windowMs: cfg.windowMs,
        createdAt: created.get(task.id),
      });
      if (!v.silent && announced.get(task.id) !== v.verdict) {
        announced.set(task.id, v.verdict);
        verdicts.push(v);
        writeAudit(record({ mechanism: "watchdog", event: "advise", taskId: task.id, text: v.text, blocked: false }));
      }
    }

    const line = cfg.advise ? mergeLines(verdicts) : null;
    if (line !== null) {
      // 只提示，不掐。掐轮次（interrupt_agent）始终是人的决定。
      if (typeof ctx.emit === "function") ctx.emit("fusion/advice", { text: line });
      log(line);
    }
  };

  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        sweep();
      } catch (error) {
        log("sweep 失败", error instanceof Error ? error.message : String(error));
      }
    }, cfg.sampleMs);
    if (typeof timer.unref === "function") timer.unref(); // 不许拖住 dsh 退出
    return () => clearInterval(timer);
  }, "fusion.watchdogTick()");

  trace({ event: "ready", hasTools: Boolean(tools), wired: registered, sampleMs: cfg.sampleMs, at: Date.now() });
}

/** 给测试和外部调用用的门面。 */
export const internals = {
  canDo,
  CODE,
  LEAD_ONLY,
  OWNER_OR_LEAD,
  ANY_MEMBER,
  readySet,
  conflictMap,
  describeBoard,
  candidatesFor,
  judge,
  mergeLines,
  decide,
  planWorktree,
  checkScope,
  record,
  toLine,
  summarize,
};
