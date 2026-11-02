# Bench：每个机制一行，带代价数字

纪律从 multica 继承：**没有 bench 行的机制不许进主分支。** 一行必须能回答两个问题——它拦到过什么，它花掉多少。

跑法：

```
node --test          # 65 assertions
```

---

## 行 1 `fusion-authority` —— 权责矩阵

| 项 | 值 |
|---|---|
| 断言数 | 11 |
| 覆盖面 | 14 个动作 × 2 个角色 = 28 格全测 |
| 与源码对齐 | `spawn`（agent-team L1006）、`interrupt`（L965）、`reassign`（L1339）三处 `TEAM_LEAD_REQUIRED`；`TEAM_TASK_UNAUTHORIZED`（L1282）；`TEAM_TASK_ALREADY_CLAIMED`（L1289）；`TEAM_TASK_BLOCKED`（L1290）；`TEAM_SELF_MESSAGE`（L1592 前） |
| 成本 | 0（纯函数，无 IO） |
| 失败条件 | 任一动作的判定与 dsh 源码不一致；三个集合出现重叠或遗漏（有专门一条断言守护） |

**为什么值钱**：删掉全部系统提示，这 28 格判定仍然拦得住。这是「分层靠代码不靠提示词」的可执行版本。

## 行 2 `fusion-board` —— ready-set

| 项 | 值 |
|---|---|
| 断言数 | 8 |
| 覆盖面 | 就绪判定、可接集合、写域重叠（路径分量，不是字符串前缀）、进行中冲突对、候选人提示、一行描述 |
| 与源码对齐 | `taskReady()` L354（前置不存在 ≠ completed，必须算未就绪）；`scopesOverlap()` L345-347；`writeScopeWarnings` L369-372 |
| 成本 | O(n²) 冲突对，n=任务数；256 任务上限下最坏 32k 次字符串比对，单次 < 2ms |
| 失败条件 | 描述里出现「分派/指派/派活」字样（有断言守护）；候选人被静默丢弃 |

**为什么值钱**：路由变成可计算的数据。没有「谁负责分派」这个问题，因为分派不是动作。

## 行 3 `fusion-watchdog` —— 语义活性

| 项 | 值 |
|---|---|
| 断言数 | 10 |
| 覆盖面 | 3 类 verdict + 时间窗门 + 宽限期 + 合并去重 + 红线 |
| 采样成本 | 30s 一次；每任务最多留 2 小时窗口（240 条）；10 任务 = 2400 条采样，约 200KB 内存 |
| 判定成本 | 每任务每 tick 一次线性扫描（≤240 条），10 任务 < 1ms |
| 失败条件 | 返回 `interrupt: true`（有断言守护，覆盖三种 verdict）；采样跨度为 0 却给出结论；把正常推进报成卡住（有一条专门断言：revision 动过必须闭嘴） |

**三类 verdict 各自的现实对应**：

| verdict | 观测事实 | 真实浪费 |
|---|---|---|
| `unclaimed` | 就绪 + 写域空闲 + 超过 10 分钟宽限 | 该派没派，板子空转 |
| `silent-owner` | `in_progress` 但 owner 的状态不是 running | 死人不报丧 |
| `stuck-revision` | owner 在跑，revision 连续 6 分钟不变 | 看起来在干活，其实在打转 |

**已知假阴性**：owner 在跑一个 40 分钟的大测试，revision 一直不变 → 会误报 `stuck-revision`。缓解：消息文本写的是「任务停在 revision N 没动过」，不是「它卡死了」，人看一眼就知道是哪种。宁可晚报、不可错报这条在这里是**用措辞**兑现的，不是用阈值。

## 行 4 `fusion-dispatch` —— 派发核算

| 项 | 值 |
|---|---|
| 断言数 | 6 |
| 覆盖面 | 四条判据各一条断言 + 真派出去的代价 + 措辞检查 |
| 判据 | ①能切 ≥2 块 ②写域两两不相交 ③每块可独立验收 ④依赖链深度 ≤1 |
| 成本公式 | 分出去 = `n 条消息 + 1 次等待`；自己干 = `0 + 0`。n = 块数 |
| 失败条件 | 措辞里出现「必须/应当/任务要求你」；写域重叠却给出 `delegate` |

**四条判据为什么是这四条**：它们正好是「并行收益存在的充要条件」。写域有重叠 → 必须串行，串行没有并行收益；有块不能独立验收 → 交出去等于丢控制权；依赖链深 → 分出去只多一次往返。

## 行 5 `fusion-worktree` —— 任务 = 工作树

| 项 | 值 |
|---|---|
| 断言数 | 7 |
| 覆盖面 | 分支命名、落点、只读任务不开树、无主不开树、越界判定、Windows 反斜杠 |
| 与源码对齐 | `worktrees` L178（换 cwd）、L193（默认目录/前缀）、L286（分支存在即失败）、L297（目录存在即失败）、L357（`workingDirectory.set`） |
| 成本 | 每次开树一次 `git worktree add`（几百毫秒）+ 一份工作副本磁盘占用；只读任务 0 |
| 失败条件 | 只读任务开出工作树；越界路径没被列进 `outside` |

**它关掉的坑**：dsh 的写域是 advisory（POLICY L23 原文 "not a lock"）。两个人真的改同一个文件时，源码只会给一句警告。这里把警告变成提交前的判定。

## 行 6 `fusion-audit` —— 机制自身的审计

| 项 | 值 |
|---|---|
| 断言数 | 3 |
| 覆盖面 | 字段校验（非法 mechanism/event/空 text 必抛）、序列化、聚合（坏行跳过、拦截率） |
| 记录成本 | 一条 JSONL ≈ 200 字节；一次看门狗提醒 1 条，一次越权 1 条 |
| 失败条件 | 脏记录进库；聚合被一行坏数据带偏 |

**为什么必须有**：dsh 的事件日志记状态（`team/task`、`team/member`、`team/message/*`），不记机制动作。「看门狗报过几次」这个问题在 dsh 里无法回答。没有这一层，任何机制都写不出一行诚实的 bench。

## 行 7 `fusion-config` —— 配置进来的第一道闸

| 项 | 值 |
|---|---|
| 断言数 | 5 |
| 覆盖面 | `~standard` 形状、绝不同步抛错、`issues` 永不为真、怪值全退化成默认、钳位/字符串数字/取整、布尔严格、未知键丢弃 + 幂等 |
| 与源码对齐 | `cordis/lib/index.js` L933-960 `resolveConfig()`：`Config` 必须是 standard-schema 对象，普通对象直接 TypeError |
| 成本 | 0（纯函数，一次正则无关的浅拷贝） |
| 失败条件 | `validate()` 返回 `issues`（会让整张板子消失）；把 `"30"` 当字符串塞进 `windowMs`；把 `"yes"` 当 true |

**为什么这条值钱**：配置写错，代价应该是「这项用默认值」，不是「插件不见了」。所以这一层**永不返回 issues**，只钳位和丢弃。

## 行 8 `fusion-tools` —— 四个只读工具的声明形状

| 项 | 值 |
|---|---|
| 断言数 | 6 + 10 条接线断言（`test/plugin.test.mjs`） |
| 覆盖面 | 字段表 → JSON Schema 编译、required 单独成数组、怪输入不炸、`output.render` 原样 JSON 化（1000 字不丢一个字）、四个工具都带 `output.schema`/`output.render`、只用 dsh 支持的子集关键字 |
| 与源码对齐 | `dsh-tools` L2876 `register()` 强制 `output { schema, render }`；L838 `defineTool()` 用 `parameterSchemaSpecToJsonSchema` 编译字段表；L163 `checkSchemaNode()` 只认 type/oneOf/properties/required/additionalProperties/items/enum/const |
| 成本 | 0（纯数据 + 纯函数，进程启动时算一次） |
| 失败条件 | 任一工具缺 `output`（有专门一条断言，就是这个 bug 的回归锁）；参数根不是 `object`；用了 `format`、`minimum` 之类不在子集里的关键字 |

**它关掉的坑**：漏 `output` 时 dsh 只吐一句 `1 entry did not activate`，UI 里插件仍显示「已安装」。没有这条断言，同样的错会以同样的隐蔽方式再来一次。

## 行 9 `fusion-lab` —— 改一行到生效的真实成本

| 项 | 值 |
|---|---|
| 断言数 | 0（这一行是运行时观测，不是单测） |
| 观测手段 | `DSH_FUSION_TRACE=<path>` 打开 `lib/lab-trace.mjs`；未设置时**零 IO** |
| 实测数据 | 保存源码 → `apply` 落在同一进程内，间隔约 2 秒；整场实验 5 次 `apply` + 1 次 `ready`，**零重启** |
| 成本 | 关闭时 0；开启时每次接线一行 ≈ 150 字节 JSONL |
| 失败条件 | 只写 `apply` 不写 `ready`（= 接线后半段抛了）；HMR 报错只进 UI、不进 stderr，所以必须有自己的见证 |

**为什么必须有**：HMR 期的异常在 stderr 上是**静默**的。没有这行 trace，「刚才那次保存到底生效没有」这个问题只能靠猜。

---

## 合计

| 行 | 断言 | 成本量级 |
|---|---|---|
| authority | 11 | 0 |
| board | 8 | < 2ms / 256 任务 |
| watchdog | 10 | 30s tick，< 1ms，约 20KB/任务 |
| dispatch | 6 | 0 |
| worktree | 7 | 一次 `git worktree add`，几百 ms |
| audit | 3 | 200 字节 / 条 |
| config | 5 | 0 |
| tools | 6 + 10 接线 | 0（启动时算一次） |
| lab | 0（运行时观测） | 关闭 0 / 开启 150 字节每次 |
| **合计** | **65** | 常驻内存 < 300KB，CPU 空闲 < 0.1%，改一行 ≈ 2 秒生效 |
