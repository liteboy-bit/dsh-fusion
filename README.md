# dsh-fusion

给 DeepSeek Harness（dsh）做的**融合扩展**：把 dsh 已经有的三样东西——agent-team 的任务 DAG、worktree 的任务隔离、projection 的共享状态——和我们在 multica 上摸出来的**机制审计纪律**缝在一条线上。

不是又一个编排框架。它**不抢权、不掐人、不派活**。

```
dsh 有什么                            我们补什么
─────────────────────────────────────────────────────────────
任务 DAG（taskReady/claim CAS）   →   可接集合可见 + 该派没派会被说出来
写域 advisory（"not a lock"）     →   claim 开工作树，complete 前判越界
wait_agent 被动等待               →   语义活性判定（在跑但不动 = 最贵的失败）
agent/status 事件唤醒             →   同一症状只说一次，绝不刷屏
interrupt_agent 掐这一轮          →   永不自带 interrupt，掐不掐是人的决定
```

## 三句话

1. **dsh 里没有 Router，也没有看门狗。** 路由是纯函数 + 一次 CAS，看护是被动等待 + 事件唤醒。任何把它们做成「角色」的框架，都是在给模型加一份不该有的工作。
2. **队长有权限，没义务。** `reassign` 在源码里只写 `if (!lead) throw`，没有一行要求队长必须分发。分发是成本，不是纪律。
3. **一个任务 = 一个 git 工作树。** dsh 的 `worktrees` 服务早就能做，缺的只是「任务板 ↔ 工作树」这条绑定。

完整源码取证见 [docs/RATIONALE.md](docs/RATIONALE.md)。

## 装

```powershell
# 在 dsh profile 目录（默认 %LOCALAPPDATA%\..\profile）里
pnpm add https://codeload.github.com/liteboy-bit/dsh-fusion/tar.gz/refs/heads/main
```

`postinstall` 会把 `dsh-fusion` 追加进 `dsh.profile.bundles`，插件的 `cordis.patch.yml` 会在 `dsh-base` 之后插入 `fusion` 插件。

详见 [docs/INSTALL.md](docs/INSTALL.md)。探索期怎么改一行立刻看到效果、怎么不重启、怎么先在一个独立 profile 里试：见 [docs/LAB.md](docs/LAB.md)。

## 拿出来的是什么

```js
import { canDo, readySet, judge, decide, planWorktree, checkScope, record } from "dsh-fusion/core";

canDo({ action: "reassign", role: "member" });     // { allowed: false, code: "TEAM_LEAD_REQUIRED" }
readySet(tasks);                                    // 只列可接，不排序，不挑人
judge({ task, ready, samples, now });               // { verdict: "stuck-revision", interrupt: false, text }
decide(plans);                                      // { verdict: "self", reason: "切了也要串行", cost: {messages:0,waits:0} }
planWorktree(task);                                 // { open: true, branch: "task/task-4", path: ".agents/worktrees/task-task-4" }
checkScope(task, changedPaths);                     // { ok: false, outside: ["server.mjs"] }
```

全是纯函数：无 IO、无 `ctx`、可单测。

## 测试

```
node --test        # 70 assertions, 9 files, 0 dependencies
```

## 它说话的时刻（也是它沉默的时刻）

四个工具和一段提示只在**有任务板的时候**才有话可说：没有团队、没有任务的普通对话里，这套东西一个字都不会出现在你眼前——这是刻意的，不是没生效。

- **有团队、有任务时**：`fusion_board` 给出可接集合与写域撞车（dsh 自带的 `team_task_list` 也能给，我们只多做「撞车」这一层）。
- **准备分活时**：`fusion_plan` 给 `delegate` / `self` / `keep` 的判定和往返成本——这一条 dsh 自己不会告诉你。
- **越权动作**：`fusion_can` 的答案抄自硬检查，不是提示词。
- **提交前**：`fusion_worktree_hint` 给分支、路径、以及改过的文件有没有越出写域。

## 边界

- 默认**只读**：只注册 `fusion_board` / `fusion_can` / `fusion_plan` / `fusion_worktree_hint` 四个查询工具，不注册 spawn / interrupt / 写文件的工具。
- 看门狗永不返回 `interrupt: true`。这不是默认值，是写死的字段。
- 采样窗短于 6 分钟不下任何结论（`unknown`）。
- 不做 Router 角色；不 fork UI；不重写 `ctx.subagents`。

## 许可

MIT
