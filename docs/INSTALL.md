# 安装

## 前提

- dsh Desktop 已装，`$DSH_HOME` 存在（默认 `C:\Users\<you>\.dsh-beta`）
- profile 目录：`$DSH_HOME\profiles\desktop\`
- Node >= 20

## 一、从 GitHub 装（推荐）

```powershell
cd "$env:USERPROFILE\.dsh-beta\profiles\desktop"
pnpm add https://codeload.github.com/liteboy-bit/dsh-fusion/tar.gz/refs/heads/main
```

`postinstall`（`scripts/ensure-profile-bundle.mjs`）会从 `INIT_CWD` / `npm_config_local_prefix` / `cwd` 往上找最多 8 层，找到带 `dsh.profile.bundles` 的 `package.json`，把 `dsh-fusion` 追加进去，并向 stdout 打一行确认：

```
dsh-fusion: appended to bundles (C:\Users\you\.dsh-beta\profiles\desktop)
```

没打这行说明它没找到 profile，此时手动补：

```jsonc
// profiles\desktop\package.json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-fusion"]
    }
  }
}
```

## 二、本地开发装

```powershell
cd "$env:USERPROFILE\.dsh-beta\profiles\desktop"
pnpm add file:C:\ai\learn\dsh-fusion
```

## 三、验证

重启 dsh 后，在任一会话里：

```
fusion_board
```

返回一行板子现状。没有这个工具 = 插件没加载，先看 `cordis.patch.yml` 是否被读到：

```powershell
Get-Content "$env:USERPROFILE\.dsh-beta\profiles\desktop\cordis.yml"
```

`bundles` 里的每个包，dsh 都会读它 `package.json` 的 `dsh.bundle.patch` 指向的文件并合并。我们的 patch 是：

```yaml
- insert:
    - id: fusion
      name: dsh-fusion
      config:
        windowMs: 360000      # 观察窗 6 分钟，短于它不下结论
        sampleMs: 30000       # 每 30 秒采一次
        advise: true          # 出一行提示
        tools: true           # 注册三个只读工具
```

## 四、和官方 agent-team profile 一起用

官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 的 patch 会 **关掉** 四个旧的单发委派工具：

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

`dsh-fusion` 自己的 patch **不动这些**，只追加插入。要不要关掉，由你在**自己的 profile patch** 里决定——这是默认值的归属问题，不该由插件替你做。

如果两个 profile 都装了，加载顺序按 `bundles` 数组顺序；`dsh-fusion` 建议放最后，这样它能覆盖到 `fusion.*` 配置项而不被别人改回去。

## 五、卸载

1. 从 `package.json` 的 `dsh.profile.bundles` 里删掉 `"dsh-fusion"`
2. `pnpm remove dsh-fusion`
3. 重启

插件不写任何自己的状态文件（审计走 `ctx.emit("fusion/audit")`，落盘由 dsh 负责），所以卸载不会留垃圾。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `fusion_board` 不存在 | bundle 没被读到 | 检查 `bundles` 数组拼写；确认 profile 目录是 dsh 实际用的那个 |
| 工具在，但总返回 `TEAM_NOT_MEMBER` | 当前 session 不在任何 Agent Team 里 | 先 `spawn_teammate`，或者从 lead 会话里调用 |
| 一眼都没提示过 | 采样窗 < 6 分钟 | 正常。窗口不够长不下结论 |
| 提示重复刷 | 不该发生 | `announced` map 按 taskId 记上一次的 verdict；若真重复，是有多个 root 在扫，报 issue |
| `agentTeams` 注入失败 | 服务名变了（dsh 升级） | `lib/index.js` 顶部 `inject` 改成新名；core 层模块不受影响 |
