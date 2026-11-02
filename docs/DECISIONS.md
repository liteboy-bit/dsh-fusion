# 决策记录

每条都必须能回答：**它拿掉了什么问题，代价是什么。** 没有代价的决策是幻觉。

---

## D1 不设 Router 角色，路由做成纯函数

**拿掉的**：一个必须存在的调度者。dsh 里 `taskReady()` 是个三行纯函数（`agent-team/lib/index.js` L354），`claim` 是一次 CAS（L1288-1295），「派活」这个动作在源码里不存在。

**代价**：没有人在「该派没派」的时候主动做决定。所以补了一条 `unclaimed` 判定，把这件事变成可见的，而不是把责任塞回给某个角色。

---

## D2 看门狗只判定，永不返回 `interrupt: true`

**拿掉的**：自动掐人带来的误杀。一个 40 分钟的大测试会被误判成「卡住」。

**代价**：卡住的队伍需要人（或队长）看一眼才能解套。这是故意的——dsh 的 `interrupt_agent` 也只给队长，且「保留 inbox」（tool-agent-team L350）。

**兑现方式**：`interrupt` 不是默认参数，是返回值里写死的 `false` 字段；`test/watchdog.test.mjs` 有一条断言覆盖三种 verdict 全都不许自带 interrupt。

---

## D3 窗口不够长不下结论

**拿掉的**：假阳性。以前用 8 分钟窗口判 10 分钟的空转，报出来的全是噪声。

**代价**：真出事会晚报几分钟。dsh 自己的 `wait_agent` 也是这个取向——它宁可在没人跑的时候立刻返回 `noProgress`，也不给你一个「还在跑」的假信号。

---

## D4 派发是成本判断，不是流程步骤

**拿掉的**：「队长必须分发」这条纪律，以及它带来的固定社交开销。

**代价**：队长要自己算一下值不值。四条判据（切得开 / 写域不相交 / 各自可验收 / 依赖链 ≤1）把它变成可判定，`dispatch.decide()` 顺手把往返成本算出来（`n 条消息 + 1 次等待`）。

**依据**：`reassign` 在源码里只写了 `if (!lead) throw`（L1339），没有反过来要求队长必须 reassign。

---

## D5 写域从 advisory 升级成 structural，但不改 dsh

**拿掉的**：「两个人改同一个文件」这种只能靠自觉避免的冲突。dsh 自己写明 "Write-scope overlap is advisory, not a lock"（tool-agent-team POLICY L23）。

**代价**：每个要改文件的任务多一棵工作树（一次 `git worktree add` + 一份磁盘）。只读任务不开树，所以调研类任务零成本。

**不改 dsh 的理由**：`worktrees` 服务（L178/L193/L286/L297/L357）已经把坑踩完了——分支存在即失败、清 16 个 `GIT_*` 变量、`core.hooksPath=/dev/null`。我们只补「任务 ↔ 工作树」这条绑定。

---

## D6 权责靠代码，不靠提示词

**拿掉的**：删掉系统提示就散架的权限设计。

**兑现**：`authority.mjs` 的 14 个动作 × 2 个角色 = 28 格全部有断言，且与源码三处 `TEAM_LEAD_REQUIRED`（L1006/L965/L1339）逐一对齐。改 dsh 版本导致判定漂移时，测试会先炸。

---

## D7 插件默认只读，不注册任何可变更工具

**拿掉的**：新插件一上来就抢 `spawn` / `interrupt` 的风险。

**代价**：想让它真的开工作树、真的掐轮次，得改配置或另起一个显式授权的插件。

**理由**：`dsh-experimental-agent-team-profile/cordis.patch.yml` 的做法是**关掉**旧的委派工具（L4-14），而不是再加一个更强的角色。同一套 seam，换的是策略层，不是权限层。

---

## D8 每个机制一行 bench，没行不许进主分支

**拿掉的**：「这个机制有用吗」这个问题永远无法回答。

**代价**：写机制的时间大约翻倍（测试 + 代价估算）。

**来源**：multica 那条 45 行 bench 的教训。dsh 的事件日志只记状态（`team/task`、`team/member`、`team/message/*`），不记机制动作——`audit.mjs` 补的就是这一层，字段固定为 `at/mechanism/event/taskId/subject/code/blocked/ms/text`。

---

## D9 multica 侧暂停

按指示，multica 的改造先放着。它的可扩展性问题（多人会话携带的上下文太大）在 dsh 这边有现成答案：状态只有一份（根 session 日志），其余都是投影；mailbox 变化不发新视图（L682-725 的 WeakMap 复用）。

**恢复条件**：dsh-fusion 在本机真实跑通一轮（看门狗报对一次、工作树开对一棵、越界拦对一次）之后再谈要不要回头改 multica。
