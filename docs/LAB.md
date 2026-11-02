# 独立工作区：`fusion-lab` profile

这份文档回答三件事，全部有实测证据，不是推测：

1. 改插件到底要不要重启 dsh？
2. 重启会不会伤到已有会话？
3. 插件会不会套到每一个会话上——怎么先开一个单独的地方试？

结论先给：

| 问题 | 答案 |
|---|---|
| 要不要重启 | **改源码不用**。`link:` 安装 + HMR 指到仓库目录，保存即生效（实测 ~2 秒）。只有**替换已安装的包版本**才要重启 |
| 重启伤会话吗 | 会话是落盘的 JSONL，重启只丢「正在进行的那一段回复」；中断的工具调用会以「未知结果」恢复，不自动重试 |
| 套到所有会话吗 | **按 profile 生效，不是按会话生效**。用哪个 profile 启动，那个 profile 下的**全部会话**都带上它。所以先开一个单独 profile |

---

## 一、为什么是 profile，不是「新会话」

`dsh-plugin-manager` README L14 原文：

> 管理当前 profile 的插件……在 YAML 中启用 HMR 时，配置变化立即生效；未启用 HMR 时，运行中的组合保留到重启。**改动影响使用该 profile 的全部会话。**

翻译成可操作的结论：

- 「只影响这个会话」这个开关**不存在**。插件是 profile 级别的。
- 想要「新东西先在小范围试」，唯一可控的边界是 **profile**。
- 会话历史是另一个维度：`$DSH_HOME\sessions\` 是**全局**的（实测：`fusion-lab` 实例 43130 的侧栏与桌面 GUI 43120 显示同一批历史）。所以「独立工作区」隔离的是**插件组合**，不是对话记录。

这一条必须说清楚，否则会误以为开了 lab 就进了沙盒世界。

---

## 二、`fusion-lab` 的构成

```
%USERPROFILE%\.dsh-beta\profiles\fusion-lab\
├── package.json          # bundles: dsh-base, dsh-web-app, dsh-fusion
├── node_modules\dsh-fusion -> C:\ai\learn\dsh-fusion   # Junction，指到仓库本身
├── cordis.yml            # []
├── cordis.patch.yml      # HMR + fusion + 插入 agent-team
└── pnpm-workspace.yaml
```

三个关键点：

1. **`link:` 而不是 tarball**。`package.json` 里 `dsh-fusion: link:C:/ai/learn/dsh-fusion`，`node_modules\dsh-fusion` 是指向仓库的 Junction。真实路径在 `node_modules` 之外，HMR 才肯看它——`ignored` 默认就排除了 `**/node_modules`。
2. **`hmr.root` 指到仓库**。`cordis.patch.yml` 里：
   ```yaml
   - id: hmr
     config:
       root: [C:/ai/learn/dsh-fusion]
       ignored: ["**/node_modules", "**/.git", cache, data]
       debounce: 200
   ```
3. **`agent-team` 三件套得自己插**。`web` 模板不带团队运行时，不插的话 `fusion` 会卡在 `pending (waiting for service: agentTeams)`：
   ```yaml
   insert:
     - id: agent-team      # @deepseek-ai/dsh-experimental-agent-team
     - id: tool-agent-team # freshProvider: spawn / forkProvider: fork
     - id: ui-agent-team
   ```

---

## 三、启动

```powershell
dsh --profile fusion-lab --port 43130 --no-open
```

**必须写 `--profile`。** 桌面版在 PATH 上的 `dsh` 是个 shim，会往 argv 前面塞 `--profile desktop`，所以 `dsh fusion-lab --port …` 会被当成 app 参数，报 `too many arguments. Expected 0 arguments but got 1`。

启动横幅第二行给出带 token 的地址，必须用带 token 的那个：

```
dsh web: http://127.0.0.1:43130/?token=…
```

裸 `/` 是 401。

| | 端口 | profile | 插件组合 |
|---|---|---|---|
| 桌面 GUI | 43120 | `desktop` | 现有那套（**不动**） |
| 实验区 | 43130 | `fusion-lab` | 现有那套 + `dsh-fusion` + 团队运行时 |

两个进程各自持有自己的插件组合，共用同一份会话历史与模型配置。

---

## 四、热重载：实测矩阵

| 改动 | 要重启吗 | 依据 |
|---|---|---|
| 插件源码（`lib/**`、`package.json` 的 `main`） | **不要** | 实测：保存后 ~2s 内 `apply()` 在同一进程里重跑 |
| `cordis.patch.yml` 里的 `fusion` 配置段 | **不要** | 同上（HMR 也看 profile 的 patch 文件） |
| 替换已安装的包**版本**（`pnpm add xxx@2`） | **要** | `dsh-plugin-manager` README L140：替换已有包后需重启以加载新的 JS 模块 |
| 增删插件条目（换 bundle） | 看情况 | 在线 profile 会重新组合并回报 `applied`；仅启动型 profile 报 `restart-required` |
| dsh 自身升级 | **要** | 运行时模块换了 |

### 见证方法：`DSH_FUSION_TRACE`

`apply()` 只在设了 `DSH_FUSION_TRACE=<path>` 时写一行 JSONL，否则**零 IO**。探索期打开它，就能看到「刚才那次保存有没有真的生效」：

```powershell
$env:DSH_FUSION_TRACE = "C:\ai\learn\dsh-fusion\.lab\trace.log"
dsh --profile fusion-lab --port 43130 --no-open
```

实测记录（同一进程，从未重启）：

```
03:07:41Z apply
03:08:32Z apply      ← 保存 lib/index.js
03:08:35Z apply      ← 保存 lib/config.mjs
03:09:07Z apply
03:11:21Z apply
03:11:21Z ready      ← 工具注册成功，接线完成
```

`apply` 出现 = 模块被替换并重新执行；`ready` 出现 = 四个工具全部注册完成。**只看到 `apply` 没有 `ready` = 后半段抛了**，这就是最快的失败信号。

**一条实测出来的操作纪律**：新增一个模块文件、同时改它的 import 方时，**保存两下**。第一下常常落在「新文件还没被 HMR 图收录」的窗口里，模块图解析失败；那一轮之后条目会停在坏状态，直到下一次成功重载。表现是：trace 里什么都没多，控制台也什么都不说。第二下就干净了。这属于「HMR 期的异常只进 UI」的连带后果，不是插件的问题。

---

## 五、重启到底丢什么

| 东西 | 重启后 |
|---|---|
| 会话记录 | 在。`$DSH_HOME\sessions\<cwd-slug>\*.jsonl`，实测 468 个文件 |
| 会话检查点 | 在。每次模型请求前、每个顶层工具产生副作用前都会刷盘（`dsh-session-checkpoint-policy`） |
| 还没写完的那段 assistant 回复 | 丢。这一段是瞬时流 |
| 正在跑的工具调用 | 回来是「未知结果」，**不会自动重试** |
| 任务板（agent-team） | 在。状态在根 session 日志里（`team/task` 事件） |

所以重启代价 = 一句没收完的话 + 一次人工确认要不要重跑。对一个探索期插件，能免则免（上面那张表），但不必当大事。

---

## 六、从实验区毕业到桌面

1. 实验区跑到「不再天天改」；
2. 打 tag，`pnpm add <repo>#v0.x` 装进 `desktop` profile（tarball 版，不再是 `link:`）；
3. 重启桌面版一次。

`desktop` profile 的 HMR 保持关闭——稳定版不需要热的，热的是实验区。

---

## 七、这两个坑是实测踩出来的（源码依据）

写在这里，免得下次再踩：

1. **`Config` 必须是 standard-schema 对象**，不能是普通对象。
   `cordis/lib/index.js` L933-960 `resolveConfig()` 会调 `runtime.Config["~standard"].validate(config)`，普通对象直接 `TypeError: Cannot read properties of undefined (reading 'validate')`。
2. **`tools.register()` 必须给 `output`**。
   `@deepseek-ai/dsh-tools` L2876：
   ```js
   if (output === void 0 || typeof output.render !== "function")
     throw new TypeError(`tool "X" must declare output { schema, render, presentationMeta? }`);
   ```
   而且 `defineTool()` 收的是**字段表**（`{name:{type,required}}`），`register()` 收的是**编译后的 JSON Schema**——中间那步编译得自己做（`lib/tool-shape.mjs`）。
   症状极隐蔽：控制台只有一句 `dsh: warning: 1 entry did not activate`，插件在 UI 里照样「已安装」。

3. **可选服务用 `ctx.get("tools")`，不要 `ctx.tools`**。
   cordis 的 Context 代理对没在 `inject` 里声明的服务**读取即抛**（`cannot get property "tools" without inject`）；而声明进 `inject` 又会变成硬依赖（服务不在就 `pending`）。只读工具属于「有就挂、没有就算了」，走 `ctx.get`。
