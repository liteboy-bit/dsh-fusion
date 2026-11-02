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
import { judge, mergeLines, DEFAULT_WINDOW_MS } from "./core/watchdog.mjs";
import { decide, describe as describeDispatch } from "./core/dispatch.mjs";
import { planWorktree, checkScope } from "./core/task-worktree.mjs";
import { record, toLine, summarize } from "./core/audit.mjs";

export const name = "dsh-fusion";

/** agentTeams 是硬依赖：没有它就没有板子可看。 */
export const inject = ["agentTeams"];

export const Config = {
  /** 观察窗（毫秒）。短于它不下结论。 */
  windowMs: DEFAULT_WINDOW_MS,
  /** 采样间隔（毫秒）。 */
  sampleMs: 30_000,
  /** 是否把判定写进一行提示（关掉就只剩审计）。 */
  advise: true,
  /** 是否注册 fusion_board / fusion_can / fusion_plan 三个只读工具。 */
  tools: true,
};

/**
 * @param {any} ctx cordis Context
 * @param {Partial<typeof Config>} config
 */
export function apply(ctx, config = {}) {
  const cfg = {
    windowMs: config.windowMs ?? Config.windowMs,
    sampleMs: config.sampleMs ?? Config.sampleMs,
    advise: config.advise ?? Config.advise,
    tools: config.tools ?? Config.tools,
  };

  const log = (...args) => {
    if (typeof ctx.logger?.info === "function") ctx.logger.info("[fusion]", ...args);
  };

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

  if (cfg.tools && typeof ctx.tools?.register === "function") {
    ctx.effect(
      () =>
        ctx.tools.register({
          name: "fusion_board",
          description:
            "只读：一次说清任务板现状——完成/进行中/可接各有几个、哪些可接、写域有没有撞车、谁适合接。不做指派，不改状态。",
          parameters: {},
          async execute(_args, exec) {
            const agent = exec?.agent;
            if (agent === undefined) throw new Error("fusion_board 需要调用者身份");
            const tasks = allTasks(agent);
            const text = describeBoard(tasks);
            const ready = readySet(tasks);
            const members = allMembers(agent).filter((m) => m.name !== "lead");
            const hints = ready.map((t) => ({
              task: t.id,
              candidates: candidatesFor(t, tasks, members.map((m) => ({ name: m.name }))),
            }));
            return { text, ready: ready.map((t) => t.id), conflicts: conflictMap(tasks), hints };
          },
        }),
      "fusion.board()",
    );

    ctx.effect(
      () =>
        ctx.tools.register({
          name: "fusion_can",
          description:
            "只读：在动手之前问一句「我这个身份能不能做这个动作」。答案抄自 dsh 的硬检查，不是提示词。",
          parameters: {
            action: {
              type: "string",
              required: true,
              description:
                "spawn/interrupt/reassign/claim/complete/release/edit/set_dependencies/reopen/delete/send_message/list/get/wait",
            },
            task_id: { type: "string", description: "涉及任务时给出，用来判断 owner 与状态" },
            target: { type: "string", description: "send_message 的目标成员名" },
          },
          async execute(args, exec) {
            const agent = exec?.agent;
            if (agent === undefined) throw new Error("fusion_can 需要调用者身份");
            const who = roleOf(agent);
            if (who === undefined) {
              return { allowed: false, code: "TEAM_NOT_MEMBER", reason: "这个 session 不在任何 Agent Team 里" };
            }
            const tasks = allTasks(agent);
            const task = args.task_id === undefined ? undefined : tasks.find((t) => t.id === args.task_id);
            const targetId =
              args.target === undefined ? undefined : allMembers(agent).find((m) => m.name === args.target)?.id;
            return canDo({
              action: args.action,
              role: who.role,
              isOwner: task?.ownerName === who.name,
              callerId: agent.id,
              targetId,
              task: task === undefined ? undefined : { status: task.status, ownerId: task.ownerName, ready: task.ready },
              targetHasDependents:
                task === undefined
                  ? undefined
                  : tasks.some((t) => t.status !== "deleted" && t.id !== task.id && t.blockedBy.includes(task.id)),
            });
          },
        }),
      "fusion.can()",
    );

    ctx.effect(
      () =>
        ctx.tools.register({
          name: "fusion_plan",
          description:
            "只读：给定几块活（主题 + 写域 + 能否独立验收），回答该自己干还是分出去，并把往返成本算出来。不派发。",
          parameters: {
            parts: {
              type: "array",
              required: true,
              items: { type: "object" },
              description: "每块：{subject, write_scopes[], blocked_by[], verifiable}",
            },
          },
          execute(args) {
            const d = decide(
              (Array.isArray(args.parts) ? args.parts : []).map((p) => ({
                subject: p?.subject,
                writeScopes: p?.write_scopes ?? p?.writeScopes,
                blockedBy: p?.blocked_by ?? p?.blockedBy,
                verifiable: p?.verifiable === true,
              })),
            );
            return { verdict: d.verdict, reason: d.reason, cost: d.cost, text: describeDispatch(d) };
          },
        }),
      "fusion.plan()",
    );

    ctx.effect(
      () =>
        ctx.tools.register({
          name: "fusion_worktree_hint",
          description:
            "只读：给出某个任务该不该开独立工作树、开在哪、提交前越界怎么判。不真的创建工作树（创建走 worktrees 工具）。",
          parameters: {
            task_id: { type: "string", required: true },
            changed_paths: { type: "array", items: { type: "string" }, description: "本次改动路径，给判越界用" },
          },
          async execute(args, exec) {
            const agent = exec?.agent;
            if (agent === undefined) throw new Error("fusion_worktree_hint 需要调用者身份");
            const task = allTasks(agent).find((t) => t.id === args.task_id);
            if (task === undefined) return { found: false, text: `板上没有 ${args.task_id}` };
            const plan = planWorktree(task);
            const changed = Array.isArray(args.changed_paths) ? args.changed_paths : [];
            return {
              found: true,
              plan,
              ...(changed.length === 0 ? {} : { scope: checkScope(task, changed) }),
            };
          },
        }),
      "fusion.worktreeHint()",
    );
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
