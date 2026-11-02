# dsh super agent 源码研究：看门狗、Router、分层、session、任务=仓库

研究对象不是论文，是**装在这台机器上的源码**：

```
C:\Users\zouwei\AppData\Local\Programs\DSH Desktop Beta\resources\app\node_modules\@deepseek-ai\
  dsh-experimental-agent-team\lib\index.js                       1640 行（服务本体）
  dsh-experimental-tool-agent-team\lib\index.js                   552 行（模型能看到的工具）
  dsh-experimental-agent-team-profile\cordis.patch.yml             32 行（怎么装、关掉什么）
  dsh-experimental-worktree\lib\index.js                          368 行（任务=工作树）
  dsh-timeout\lib\index.js                                        （唯一的 watchdog）
```

版本 `0.2.1-alpha.2`，仓库 `github.com/deepseek-ai/deepseek-harness`，目录 `packages/experimental/`。

---

## 0. 三句话结论

1. **dsh 里没有 Router，也没有看门狗。** 这两个词是论文里的角色，落到实现里被拆成了四件互不相干的东西：`wait_agent` 的被动等待、`agent/status` 事件、`interrupt_agent` 的「掐这一轮不掐这个人」、以及 `dsh-timeout` 里真正的 `idleWatchdog`（长度看门狗，只管流是否活着）。没有任何一个 agent 被赋予「路由」或「看护」的职责。
2. **路由是数据，不是人。** 一个任务能不能被接，由 `taskReady()` 一个纯函数算；谁能接，由 `claim` 的 CAS 决定；撞车由 `scopesOverlap()` 算警告。**「派活」这个动作在源码里不存在**——没有人把任务交出去，任务只是从「不可接」变成「可接」。
3. **session 没有被消除，它被提升成了唯一的账本。** `TeamId(rootId)`：队伍的 id 就是根 session 的 id。成员是它的 `parentSession` 子节点，全部队伍状态以四个 `team/*` 事件追加进**根 session 的日志**，flush 成功后才广播。「共享订阅」= 投影（projection）+ 事件等待者，不是多个 session 互相喊话。

---

## 1. dsh 真实的分层

不是「人分层」，是**能力分层**。每一层都能单独替换：

| 层 | 组件 | 它拥有什么 | 证据 |
|---|---|---|---|
| L0 机制 | `ctx.subagents` | provider 注册表：spawn / fork / continuable / spawn-in-process。只是「能生出子 agent」 | `dsh-subagent` 包描述："named-provider registry for delegating to child agents" |
| L1 编制 | `TeamService` | roster（成员名/阶段）、journal（事务）、task board（DAG）、mailbox（消息）、lifecycle（准入/回收） | `agent-team/lib/index.js` L1430-1640 |
| L2 工具 | `tool-agent-team` | 模型能看见哪 8 个工具、每个工具的参数、以及一段 `POLICY` 系统提示 | `tool-agent-team/lib/index.js` L21-27、L236-518 |
| L3 隔离 | `WorktreeService` | 给一个 session 换 cwd 到独立 git 工作树 | `dsh-experimental-worktree` L178、L357 |
| L4 经济 | `spill` / `spill-policy` / `compaction` / `session-search` | 大块工具结果落盘换 locator；历史会话检索 | 各包描述 |
| L5 部署 | bundle 的 `cordis.patch.yml` | 一个插件 = 一个 yml patch + 一个 Service + 若干工具 | `agent-team-profile/cordis.patch.yml` 全文 32 行 |

**关键设计决定在 L5，不在 L2。** 官方 profile 做的是：

```yaml
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
```

`agent-team-profile/cordis.patch.yml` L4-14。意思是：**不新增一个「队长」角色，而是把旧的单发委派工具关掉，让所有委派只能走 Team 工具。** 分层是靠「哪些工具存在」实现的，不是靠提示词告诉谁该听谁的。

这条正好是我们的 D6（权责靠代码不靠提示词）在别人代码里的实现方式。

---

## 2. 「看门狗」的定义

### 2.1 源码里叫 watchdog 的只有一处

```js
// dsh-timeout/lib/index.js
* Create a rearmable idle watchdog for an async iterator. The timer exists only
```

它是**流级别的空闲计时器**：LLM 流多久没吐字节就判超时。跟「这个 agent 是不是在原地打转」毫无关系。

其余的 `watchdog` 出现在 `dsh-otel`（批次发送的告警）、`dsh-session-telemetry-otel`（排空超时）、Electron 渲染进程的 `renderer-surface-watchdog`。**队伍层面没有任何看门狗。**

### 2.2 dsh 用什么替代了看门狗

三件东西，各管一段：

**（a）被动等待，且拒绝假装有进展** —— `wait_agent`

```js
// tool-agent-team/lib/index.js L328
"Wait for the next teammate status, message, or shared-task change after this call starts.
 This never wakes inactive members and returns noProgress immediately when no other member is
 running or provisioning. Re-list after wakeup or timeout instead of polling."
```

```js
// 同文件 L338-344：没人活着跑，立刻返回 noProgress，不进等待
if (!ctx.agentTeams.listMembers(caller).some((m) => m.id !== caller.id && ACTIVE_WAIT_STATUSES.has(m.status)))
  return { timedOut: false, noProgress: { reason: "no-active-peer", message: NO_ACTIVE_PEER_MESSAGE } };
```

这两行是整份源码里最值得我们抄的东西：**它宁可告诉你「等下去不会有结果」，也不让你在那儿干等。** 我们的 `progress.mjs` 走的是另一条路（判「打转」），方向对，但缺这个 `noProgress` 式的硬拒绝。

**（b）事件唤醒，不轮询** —— `TeamActivity`

```js
// agent-team/lib/index.js L47-88  wait(id, timeoutMs, signal)，超时 10s～1h 强制校验（L48）
// L94-99  notify(id)：唤醒并清空该队伍当前等待者
// L1469-1472  ctx.on("agent/status") → this.activity.notify(membership.id)
// L158-160  appendAndFlush 成功后同步 onCommit → notify
```

超时上限一小时、下限十秒是硬编码校验，不是建议。

**（c）唯一的「掐断」，掐的是轮次不是人** —— `interrupt_agent`

```js
// tool-agent-team/lib/index.js L350
"Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only."
```

`TeamRoster.interrupt()`（L963-977）里做的是 `this.ctx.subagents.interrupt(target.id, { kind: "ancestor", agent: caller })`——取消当前 activation，inbox 不动，成员不掉线。**对比我们的 `_preemptForHuman`：杀进程重启。名字像，实质不同，这个判断到现在仍然成立。**

### 2.3 真正的空白：语义活性

把上面三段拼起来会发现一个洞：**一个成员可以 `status === "running"`（有轮次在执行），十分钟不动一个 revision。** dsh 对此没有任何判定，因为它默认「有没有进展」是模型自己的责任。

这就是我们该补的那一格，也是 `lib/core/watchdog.mjs` 唯一的立足点。三条硬约束：

1. **只判定，不动作。** 返回值里 `interrupt: false` 是写死的字段，不是默认值——想让它掐人，必须改源码。
2. **窗口不够长不下结论。** 采样跨度 < `windowMs` 一律 `unknown`。这条是上一轮踩过坑之后加的（8 分钟窗口判 10 分钟的空转，判出假阳性）。
3. **同一症状只出现一次。** `mergeLines()` 按 verdict 分桶，绝不刷屏。

判定分三类，各自对应一种真实的浪费：

| verdict | 事实 | 为什么值钱 |
|---|---|---|
| `unclaimed` | 任务就绪、写域空闲、过了宽限还没人接 | 这是「该派没派」唯一能被观测到的形态 |
| `silent-owner` | 有主，但 owner 的轮次早就不在跑了 | 死人不报丧，板子看起来还在动 |
| `stuck-revision` | 有主、在跑、revision 长时间不动 | 最贵的失败：看起来在干活，其实在打转 |

---

## 3. 「Router」的定义

### 3.1 源码里没有 Router

`@deepseek-ai` 下 600 多个包里，`Router` 只出现在 HTTP 路由、provider 路由（`dsh-llm-pi-ai` 的 provider 路由表）、以及 `dsh-client-connection` 的消息路由。**没有任何一个类是「agent 路由器」。**

### 3.2 路由实际是三个纯函数 + 一次 CAS

```js
// agent-team/lib/index.js L354  就绪判定
function taskReady(state, task) {
  return task.blockedBy.every((id) => state.tasks.find((c) => c.id === id)?.status === "completed");
}
```

```js
// L1288-1295  claim：谁想接谁接，CAS 保证只有一个成功
case "claim":
  if (current.ownerId !== void 0 && current.ownerId !== caller.id) throw ... "TEAM_TASK_ALREADY_CLAIMED"
  if (current.status !== "pending" || !taskReady(state, current)) throw ... "TEAM_TASK_BLOCKED"
  next = { ...current, status: "in_progress", ownerId: caller.id };
```

```js
// L1339  reassign：唯一「把活交出去」的动作，只要求权限，不施加义务
if (!lead) throw new TeamError("only the Team Lead can reassign tasks", "TEAM_LEAD_REQUIRED");
```

注意 `reassign` 的写法：`if (!lead) throw`。它**只**规定了「不是队长不许 reassign」，没有一行代码规定「队长必须 reassign」。这就是「队长有权限、没义务」的代码证据——你指出的那个毛病，在 dsh 的设计里根本不存在，因为**派发不是一个流程步骤，是一个可选操作**。

### 3.3 记忆检索不是 Router 的事

你问「Router 是不是要负责整个项目的路由、记忆、检索」。在 dsh 里这三件事被拆开，谁都不管谁：

| 关注点 | 归属 | 机制 |
|---|---|---|
| 路由（谁能接） | task board | `taskReady()` + `claim` CAS |
| 队伍状态（谁在、板子长什么样） | projection | `key: "agentTeam"`, `stateVersion: 4`（L727-737） |
| 历史会话检索 | `dsh-experimental-session-search` | "Give Agents tools to search and read earlier sessions from the current workspace" |
| 大块内容的经济性 | `dsh-spill` / `spill-policy` | 超出预算的工具结果落盘，返回 locator |
| 上下文压缩 | `compaction-basic` | 阈值 0.8、headroom、retainRatio |

**把这五件事压给一个叫 Router 的 agent，等于让一个模型去承担五个本来可以确定性地算出来的东西。** 这是论文里最容易误导人的一处。

---

## 4. 「三人里选一个当队长」为什么逻辑上不成立

五条，每条对着代码：

**（1）dsh 的队长不是选出来的，是「本来就在那儿」。**
```js
// agent-team/lib/index.js L267-269
function TeamId(id) { return id; }   // 注释：Brand one root Session identity as its implicit Team identity.
```
队伍的 id 就是根 session 的 id；`buildTeamProjection()`（L684-690）把 `{ name: "lead", role: "lead", phase: "active" }` 直接当成 roster 的第一行拼进去，它不是一个成员记录，是根 session 的一个视图。**没有选举，没有「从三人中挑一个」，因为另外两人本来就是它生出来的。** 我们那个「三选一当队长」的设计，等于先造出三个平级的人，再造一个没有结构理由的等级——这个等级只能靠提示词维持。

**（2）分层靠能力差，不靠提示词。**
`spawn` / `interrupt` / `reassign` 三处硬 `throw "TEAM_LEAD_REQUIRED"`（L1006、L965、L1339）；其余动作走 `authorizeOwner()`（L1282）：「不是队长就必须是 owner」。**把任何一段系统提示删掉，这些throw 都还在。** 我们的做法删掉提示词就散架——这就是 D6 的判据。

**（3）「队长能独立做完，却还被要求分发」——dsh 明确允许独立做完。**
`wait_agent` 在没人活着跑的时候返回 `noProgress`，message 原文（L29）：
> "No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again."

它给的是**选项**，不是**义务**。再看 `POLICY`（L27）里唯一一条硬要求：
> "The Lead must wait for required teammates before giving the final answer."

只在「已经派了」之后才成立。**派发本身从来不是被要求的。**

**（4）三人平级 + 一个队长 = 没有分层，只有称呼。**
真正的分层在 dsh 里是「工具集不同」：队长有 `spawn_teammate`，成员没有；队长有 `reassign`，成员没有；`team_task_update` 的 `action` 枚举里 `reassign` 对成员是死路。我们的三人小队三个人拿到的是同一套工具、同一份提示，队长唯一的特权是「被要求去说话」——这不是分层，这是加了一道社交开销。

**（5）队长的价值在于「唯一能对用户说话」，不在于「分发」。**
dsh 里队友的唯一输出通道是 `send_message({target:"lead"})`（spawn 时的注入提示 L271-277 明确写了 "Your Team Lead is named 'lead'"）。**成员不许直接对用户说话**，这一条是靠拓扑保证的（成员的 parent 是 root，用户只连 root），不是靠提示词。我们的实现里成员也能对着房间说话——于是「谁说了算」变成要靠规矩维持。

---

## 5. session 的「消除」与「共享订阅」

### 5.1 源码事实

```js
// 团队状态 = 根 session 日志上的四个事件类型（L533-535）
function isTeamEvent(event) {
  return event.type === "team/member" || event.type === "team/task"
      || event.type === "team/message/queued" || event.type === "team/message/delivered";
}
```

```js
// L156-160  先写日志、先 flush、再广播
async appendAndFlush(root, type, data) {
  root.session.append.bind(root.session)(type, data);
  await this.ctx.sessions.flush(root.session);
  this.onCommit(root);          // → activity.notify  → 唤醒等待者
}
```

```js
// L727-737  投影定义：key "agentTeam"，stateVersion 4，apply 是纯函数
const teamProjectionDefinition = { key: "agentTeam", stateVersion: 4, stateSchema, init, apply: applyProjectionEvent, wire: {...} };
```

```js
// L682-725  视图缓存：只按 members/tasks 两个集合身份做 WeakMap 缓存
// "Mailbox-only state changes reuse the previous view reference, so the live drive publishes nothing for them."
```

### 5.2 这四行合起来说明什么

- **没有「每个 worker 一个私有 session 然后互相订阅」这回事。** 只有一个日志：根 session 的。所有成员状态都是它上面的事件。
- **共享订阅 = projection + waiter。** 订阅者不是「订阅了某个成员」，而是「订阅了根日志上的队伍域事件」，投影把它折成 `{members, tasks}` 两个集合；`wait_agent` 是这套订阅的**阻塞接口**。
- **广播前必须落盘。** `await flush` 在 `onCommit` 前面，意味着任何一次唤醒都对应一条已持久化的事实。这一条决定了「重启不丢队伍状态」。
- **只有 mailbox 变化不发新视图。** 消息进出不触发 UI 重绘，因为 `WeakMap` 按 `state.members` / `state.tasks` 两个引用做缓存。

所以「消除 session」的准确说法是：**消除了「谁拥有状态」这个问题**。状态只有一个所有者（根日志），其余全是视图。我们的 multica 现在反过来——每个房间、每个 worker 各有各的 json，靠轮询对齐，这就是为什么上下文会膨胀。

### 5.3 消息投递是两阶段，不是「发出去就算完」

```js
// 事件：team/message/queued → team/message/delivered（L493-503）
// L1611 steerHostSubagentPrompt(...) 之后才 return { messageId }
// 工具描述（L300）："A successful send does not mean the recipient has processed it."
```

这条我们要学：`send` 返回的是**被接受**，不是**被处理**。我们的 `say` 没有任何投递确认。

---

## 6. 一个任务 = 一个 git 仓库（工作树）

### 6.1 dsh 已经有现成插件

```js
// dsh-experimental-worktree/lib/index.js L178
/** Creates a new Git branch and checkout, then changes the calling Session's working directory. */
```

细节全是踩过坑之后写出来的，值得逐条抄：

| 行为 | 行 | 为什么重要 |
|---|---|---|
| 默认落 `.agents/worktrees`，前缀 `worktree-` | L193 | 约定俗成，不污染主仓 |
| 工作树池目录写 `.gitignore` 内容 `*` | L24 | 池子自己不进版本库 |
| 分支已存在 → 直接失败 | L286 | 绝不静默复用一个脏分支 |
| 目录已存在 → 直接失败 | L297 | 同上 |
| 清掉 16 个 `GIT_*` 继承变量 | L92-108 | 防「以为在子仓其实在主仓」 |
| `core.hooksPath=/dev/null`、`core.fsmonitor=false` | L263 | 防本仓 hook 在工作树里跑 |
| `reset --hard` + 关掉 clean/smudge/process filter | L319-355 | 防 LFS/加密仓把工作树搞坏 |
| 成功后 `workingDirectory.set(agent, path)` | L357 | 换的是这个 session 的 cwd |
| 失败时**保留**已创建的目录和分支 | L363 | 不自动删，出问题能查 |

### 6.2 缺的那一环：绑定

`POLICY`（L23）自己写得很清楚：

> "Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. **Write-scope overlap is advisory, not a lock.**"

也就是说：任务板知道「这个任务想改 `lib/core`」，也知道「另一个进行中的任务也想改 `lib/core`」，然后它**只给一句警告**（`writeScopeWarnings`，L383）。没有任何一行代码逼着 owner 在自己的工作树里干活，也没有任何东西阻止两个人真的改同一个文件。

**这就是融合框架第一个真正有价值的位置**：把 advisory 升级成 structural。

`lib/core/task-worktree.mjs` 做的就是这件事的三条推导：

1. `branchFor(task)` → `task/task-<n>`，只认这个命名，别的名字一律拒（对应 L286 的「已存在就失败」精神）
2. `planWorktree(task)` → 只读任务不开树；没人接的任务不开树（开早了没人用）
3. `checkScope(task, changedPaths)` → 提交前判越界，越界路径列出来，进审计行

---

## 7. 我们缺的，dsh 也缺的（真正的空白清单）

| # | 空白 | dsh 现状 | 我们怎么做 |
|---|---|---|---|
| 1 | 每个成员的能力画像 | `spawn_teammate` 只有 `name / description / prompt / context`（tool L236-260），**没有 preset、没有 toolFilter、没有 model**。roster 里 `model` 是 `live?.options.model ?? root.options.model`（L922）——队友永远跟队长同模型同工具 | `fusion_profile`：给成员挂能力域（`caps`），`candidatesFor()` 按能力域过滤候选人 |
| 2 | 写域硬隔离 | advisory only（L23、L383） | `task-worktree`：claim 时开树，complete 前 `checkScope()` |
| 3 | 语义活性判定 | 无 | `watchdog`：三类 verdict，只提示，永不 `interrupt` |
| 4 | 机制自身的审计 | 事件日志记状态，不记「机制动作」 | `audit`：JSONL 一行一条，固定字段，`blocked` 用来算拦截率 |
| 5 | 「该派没派」可观测 | 无（只有 `noProgress` 的瞬时信号） | `watchdog` 的 `unclaimed`：就绪 + 写域空闲 + 过宽限 = 报一次 |
| 6 | 派发的代价核算 | 无 | `dispatch.decide()`：四条判据任一不满足就自己干，并把往返成本算出来 |

---

## 8. 融合框架的模块与它们的 bench 行

每个机制必须能回答「它拦到过什么、代价是多少」。没有 bench 行的机制不许进主分支。

| 模块 | 文件 | 换来什么 | bench 行（代价数字） |
|---|---|---|---|
| 权责矩阵 | `lib/core/authority.mjs` | 权限靠代码：删掉提示词仍能拦 | `fusion-authority`：14 个动作 × 2 角色 = 28 格，与 dsh 源码三处 `TEAM_LEAD_REQUIRED` 一致；不一致即失败 |
| ready-set | `lib/core/ready-set.mjs` | 路由变数据：可接集合纯函数算，无派发动作 | `fusion-board`：同板子重复计算结果稳定；描述里 0 次出现「分派/指派」 |
| 看门狗 | `lib/core/watchdog.mjs` | 三类空转可见，且**永不自动掐** | `fusion-watchdog`：20 条采样、10 分钟跨度；窗口 < 6 分钟时必须 `unknown`（防假阳性）；`interrupt` 字段恒为 false |
| 派发核算 | `lib/core/dispatch.mjs` | 派发从流程步骤降级成成本判断 | `fusion-dispatch`：写域重叠 / 有块不可验收 / 依赖链 > 1 → 全部 self，代价 0 往返；真分得开才报 `n 条消息 + 1 次等待` |
| 任务=工作树 | `lib/core/task-worktree.mjs` | 写域从 advisory 变 structural | `fusion-worktree`：只读任务 0 棵树；有人接 + 有写域才开；越界路径必须逐个列出 |
| 审计 | `lib/core/audit.mjs` | 每个机制有没有干活，可聚合 | `fusion-audit`：非法 mechanism/event/空 text 必须抛；坏行跳过不污染统计 |

测试：`node --test`，44 条断言，0 依赖。

---

## 9. 明确不做的

1. **不重写 subagent 机制。** `ctx.subagents` 已经是干净的 provider 接缝，重写只会破坏 dsh 升级兼容。
2. **不做 Router 角色。** 谁都不许「负责分派」，因为派发不是职责。
3. **不做自动 interrupt。** 掐人永远是人的决定；我们只负责让「该掐了」这件事可见。
4. **不 fork UI。** 只注册工具和提示位，界面沿用 dsh 自己的（`dsh-experimental-client-ui-agent-team`）。
5. **不动 multica。** 按指示，multica 侧先放着；它的教训（机制必须有 bench 行、用户可见文本不截断、宁可晚报不可错报）在这里继承。
