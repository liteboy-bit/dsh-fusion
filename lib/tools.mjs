import { describeBoard, readySet, conflictMap, candidatesFor } from "./core/ready-set.mjs";
import { canDo } from "./core/authority.mjs";
import { decide, describe as describeDispatch } from "./core/dispatch.mjs";
import { planWorktree, checkScope } from "./core/task-worktree.mjs";
import { fieldMapToJsonSchema, jsonOutput } from "./tool-shape.mjs";

/**
 * 四个只读工具的定义。全部是纯数据 + 纯函数，不碰 ctx、不开效应，
 * 这样测试可以直接把它们当对象查，接线层只负责把它们塞给 tools.register。
 *
 * 每个 execute 的第一个入参是模型给的参数，第二个是执行载体（exec.agent = 调用者）。
 */
export function defineTools({ allTasks, allMembers, roleOf }) {
  return [
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
  ].map((tool) => ({
    ...tool,
    parameters: fieldMapToJsonSchema(tool.parameters),
    output: jsonOutput(),
  }));
}
