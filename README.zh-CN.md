<div align="center">

<img src="apps/web/public/icon.svg" alt="Magister" width="120" height="120" />

# Magister

**开源的自主 AI 编程 agent 控制台。**

下发一个任务;leader agent 规划它、在隔离的 git worktree 里派出专门的 teammate、把结果交付出来 —— 在浏览器或手机上实时可见。

[English](README.md) · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-orange.svg)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-blue.svg)](https://www.typescriptlang.org)

</div>

---

## Magister 是什么？

Magister 把多个 AI 编程 agent 编排成一个受管理的团队。你描述目标；**leader agent** 把它拆成子任务，在**隔离的 git worktree** 里派出专门的 teammate（coder / reviewer / architect / evaluator / lander），并把整个委派树实时流式推送到一个随处可达的 web 控制台 —— 桌面、手机、飞书。

## 为什么选 Magister？

- **把 coding agents 当基础设施跑** —— 浏览器关掉、SSH 断开、API 重启，任务都不会随终端 session 一起死。
- **看见完整委派树** —— leader 决策、teammate spawn、工具调用、审批、diff、回复全部流进一个控制台。
- **每个角色用对的模型** —— 常驻 leader 走便宜的 API 模型；reviewer / architect / 高风险工作再用更强的模型或外部 CLI。
- **随处接管** —— 浏览器、移动端 PWA、飞书、CLI 都操作同一套任务状态。
- **自托管** —— SQLite、本地文件、本地 worktree、你的 key、你的审批规则。

## 快速开始

```bash
git clone https://github.com/UpennGitttt/CAM.git
cd CAM
bun install
cp .env.example .env       # 可选运行时配置 —— API key 不在这里设置
cp config/executors.example.json config/executors.json   # 然后选择你的 provider/model
bun run migrate             # 初始化 SQLite 数据库（建好所有表）
bun run dev:all             # 一键同时起 API（:3700）+ web 控制台（:3701），Ctrl+C 一起停
```

> 想分开两个终端？改跑 `bun run dev`（API :3700）和 `bun run dev:web`（web :3701）—— 两个都要保持运行。web 控制台代理到 API，所以满屏 `ECONNREFUSED 127.0.0.1:3700` 只是 API 没在跑；启动时偶发的 `EPIPE` / ws 代理报错是无害的（浏览器 tab 在重连）。

打开 [http://localhost:3701](http://localhost:3701)，到 **Settings → Providers** 粘贴 provider API key（如 `ANTHROPIC_API_KEY`）。key 通过 UI 存到 `config/secrets.json`（已 gitignore）—— **不是**写在 `.env` 里。agents、skills、MCP、审批规则也都在 Settings 里管理。

> 全新安装、还没配 provider 时，API 日志会打印 `Role "leader" has no provider configured yet` —— 这是**正常的、不是报错**（API 已经正常运行），配好 provider 后就消失。

长期运行（关终端不停）：`bash scripts/restart-profile.sh prod`。

### 推荐配置

每个任务都按 **Role → Agent → Provider** 解析，所以实际问题是*哪个角色用哪个模型*。一个合理的默认：

- **Leader**（常驻；规划和委派）—— 用**便宜又够用**的模型。这个循环每轮都跑，成本主要在这里；一个经济型 API 模型（如 DeepSeek、Qwen 或 Claude Haiku）就够。
- **Coder / reviewer / architect**（干重活，按需跑）—— 用**更强**的模型，或外部 CLI（Codex / Claude Code / OpenCode）。用和实现时*不同*的模型来 review，能多抓出问题。
- **从简单开始** —— 先让所有角色都指向一个 provider 跑起来，跑通后再到 **Settings → Agents** 按角色拆分。

<details>
<summary><strong>在标准 Node.js 上运行（Bun 可选）</strong></summary>

API 和 web 控制台也能跑在 **Node.js ≥ 20.11** 上（通过 [`tsx`](https://github.com/privatenumber/tsx)，用 `better-sqlite3` 替代 `bun:sqlite`，运行时自动选择，无需改代码）：

```bash
bun install                 # 仍是安装器，同时构建 better-sqlite3
bun run start:node          # 在 Node 上跑 API
bun run smoke:node:db       # 校验 Node DB 路径（驱动 + FTS5 + 迁移）
bun run smoke:node:boot     # 在 Node 上启动 API 并断言 /health
```

CI 同时跑一个 Bun job 和一个 Node job。唯一仅限 Bun 的是可选的 leader worker 模式（默认关闭）。
</details>

## 核心能力

### 多 Agent 编排

leader 是**异构编程 agent 之上的指挥者**，而不是又一个单体 agent。它能把 Codex、Claude Code、OpenCode 当作专门的 teammate 跑在同一个任务上 —— 每个在独立 worktree 里、每个角色用最合适的模型 —— 再整合结果。

- teammate 可以是 Magister 原生 agent，也可以是外部 CLI（Codex、Claude Code、OpenCode）；每个角色挑不同的模型/CLI
- 每个 teammate 在自己的 git worktree 里工作；相互独立的子任务并行跑
- spawn 事件、工具调用、返回值在 web UI 实时流式可见
- 自定义角色，带各自的模型、系统提示和工具限制

### 自主循环

leader 运行持续的 **模型 → 工具 → 观察** 循环，内置安全机制：

- **崩溃恢复** —— 每轮 checkpoint，重启后从最近一个续上
- **死循环检测** —— 对工具调用取指纹，相同调用重复 3 次自动阻断
- **上下文压缩** —— 对话变长时总结早期轮次，保留关键决策
- **Goal mode** —— 把一条 prompt 设为自主目标，直到完成或你取消

### 上下文 cache 与成本

常驻编排要划算，关键在上下文被**缓存复用**、而不是每轮重发。一次真实运行里，leader 的 input tokens 有 `98.9%` 命中 cache（`15.9M` 命中 vs `172K` 未命中）—— 这就是「能日用」和「烧钱」的区别。token 用量按 task、role、model 记录，且能和 provider 自己的面板对账。

### 执行安全

分层安全模型，防止 agent 搞坏你的系统：

- **4 级风险分类** —— LOW 自动放行、MEDIUM 一键审批、HIGH 升级审批、CRITICAL 硬拦截
- **Bubblewrap 沙箱（仅 Linux）** —— 可选的 `bwrap` 隔离，限定文件系统挂载 + 网络 unshare；macOS/Windows 上命令不走沙箱
- **持久化审批规则** —— 白名单信任的命令模式，常规操作免点击
- **变更审查闸门** —— teammate 的 diff 合入前先可视化审查

> **威胁模型：** 安全是为**单个可信操作者运行自己的 agent** 调优的 —— 尽力而为的安全网，不是抵御不可信代码的边界。唯一不可覆盖的是对灾难性、不可逆模式（`rm -rf /`、`mkfs`、`dd of=/dev/*`）的 CRITICAL 硬拦截。

### Skills 与 MCP

- **Skills** 按需加载 —— 只有名称和描述进系统提示词，正文在需要时通过 `load_skill` 加载。一个共享的 `~/.agents/skills/` 池供 Magister、Claude Code、Codex、OpenCode 使用，装一次、从一个标签页统一管理。内置一套编排纪律 skills：转述前先核实 teammate 的声明、宣布完成前先验证、调和冲突的审查意见。
- **MCP** —— Tools、Resources、Prompts，GUI 管理、按 agent 绑定、无需重启热重载。聊天框输入 `/` 调用 MCP prompt。

### Web 控制台 + 移动端

为委派树而做的实时 dashboard：

- 流式聊天 —— leader 思考、工具调用、结果实时渲染
- 响应式 PWA，手机上可用
- 看板（排队 / 进行中 / 待处理 / 完成）+ 会话搜索
- 拖拽/粘贴图片；agent 可发回截图、图表或短视频
- 飞书集成 —— 从聊天里驱动同一套任务

**在手机上访问。** 控制台是自托管在你自己机器上的，想随时随地用，就把手机和宿主机加进同一个 [Tailscale](https://tailscale.com) tailnet —— 一个加密的 WireGuard mesh，不向公网暴露任何端口，换网络也不断（Wi-Fi ↔ 蜂窝无缝切换）。

<details>
<summary><strong>通过 Tailscale 在手机上访问 —— 分步</strong></summary>

1. **在宿主机**（跑 Magister 的那台）装上 Tailscale、启动，记下它的地址：
   ```bash
   # macOS: brew install tailscale    ·    Linux: curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   tailscale ip -4        # → 100.x.y.z   （或用 MagicDNS 名：<machine>.<tailnet>.ts.net）
   ```
2. **在手机上**装 Tailscale app（iOS / Android），登入**同一个账号** —— 两台设备就在同一个私有 tailnet 里了。
3. **把 web 控制台暴露给 tailnet。** Magister 默认只监听 `127.0.0.1`。在 `.env` 里把 `WEB_HOST` 设成 Tailscale IP，可以只监听这张网卡；或者用 `WEB_HOST=0.0.0.0` 监听所有网卡：
   ```bash
   WEB_HOST=100.x.y.z
   # 或：WEB_HOST=0.0.0.0
   ```
4. **加一个登录**，别让控制台对整个 tailnet 裸奔 —— 在 `.env` 里设好后重启：
   ```bash
   MAGISTER_WEB_AUTH_USER=admin
   MAGISTER_WEB_AUTH_PASS=<一个强密码>
   ```
5. **手机上打开：** `http://100.x.y.z:3701`（Tailscale IP）或 `http://<machine>.<tailnet>.ts.net:3701`（MagicDNS），登录。
6. **添加到主屏**（浏览器分享菜单里）—— 之后就像原生 app 一样全屏启动（PWA：你的会话、实时流式、多媒体都在）。

不用端口转发、不暴露公网 —— 手机通过加密 mesh 直连你自己的机器，蜂窝网络下也能用。*（同一 Wi-Fi 下用局域网 IP 也行；要真正公网访问可以用 Cloudflare/ngrok tunnel —— Tailscale 最干净：私有、加密、还能漫游。）*

> **安全 —— 推荐这样做。** 只在本机使用时，默认的 `127.0.0.1` 监听不会被其他设备访问到。一旦把 `WEB_HOST` 设成 Tailscale/LAN 地址或 `0.0.0.0`，也建议设置 `MAGISTER_WEB_AUTH_PASS`；否则任何能访问这张网卡的人都能完全控制你的 agents。再给 **Tailscale 账号开 2FA** —— 它是整个私网的信任根。

</details>

### Provider 与记忆

- **任意 provider** —— Anthropic（Claude）以及任何 OpenAI 兼容端点（通义千问、Kimi、GLM、DeepSeek、Moonshot、火山引擎……）。配置 agent 时自动发现该 runtime 支持的模型，下拉选择而不用手敲 model ID。新增 provider 只需一个小的 dialect adapter + auth 配置。
- **跨会话记忆** —— 类型化条目（user / project / feedback / reference），按 **global / project / session** 分级，不相关项目之间的上下文不会串，FTS5 检索，自动写入和老化。

## 运行环境与平台支持

运行时：[Bun](https://bun.sh) ≥ 1.3.12（默认），或标准 Node.js ≥ 20.11。

| 平台 | 状态 | 沙箱 |
|---|---|---|
| Linux | 完整支持 | `bwrap`（可选）|
| macOS | 可运行（Unix 原生）| 无 —— `bwrap` 仅 Linux |
| Windows | 仅 WSL2 | 通过 WSL2 |

不支持原生 Windows —— agent 的 `bash` 工具、沙箱、运维脚本都假定 Unix shell。请用 WSL2。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│  Web 控制台 (React + Vite)          手机 / 飞书         │
│     SSE 流式推送    WebSocket 事件扇出                  │
├─────────────────────────────────────────────────────────┤
│  API 服务器 (Bun + Fastify)                             │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Leader Loop  │  │ MCP Pool │  │ CLI Agent Bridge  │  │
│  │（自主循环）  │  │（stdio/  │  │（Codex, Claude,   │  │
│  │              │  │  http）  │  │  OpenCode）       │  │
│  └──────┬───────┘  └────┬─────┘  └────────┬──────────┘  │
│         │               │                 │             │
│  ┌──────┴───────────────┴─────────────────┴──────────┐  │
│  │           工具注册表 + 沙箱                        │  │
│  │  bash · read/write/edit · grep · web_search       │  │
│  │  spawn_teammate · git_commit · send_media · MCP   │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  SQLite（任务、事件、审批、记忆、制品）                   │
│  文件系统（checkpoint、上传、媒体、skills）               │
└─────────────────────────────────────────────────────────┘
```

解析链：**Role → Agent → Provider**。每个角色（coder / reviewer / architect …）映射到一个 agent 配置（模型、指令、工具限制），再映射到一个 provider（端点 + 鉴权）。全部可在 Settings 配置。

## 贡献

最有价值的贡献不是样板代码，而是让 Magister 成为更好的**编程 agent 指挥者**的那些事：

- **接入更多 coding-agent CLI 作为 teammate** —— 在 CLI bridge 后面接更多 runtime（Cursor、Kiro、Qoder、OpenClaw、Hermes……），让 leader 能像委派 Codex / Claude Code / OpenCode 那样委派它们。
- **深化多 agent 编排** —— 更聪明的委派、并行与对抗式审查、规划、恢复策略。
- **新的 provider 与 model dialect** —— 给 Magister 还不会说的端点和 API 写适配器。
- **工具、skills、通道** —— 扩展 teammate 能做什么、任务从哪来。

这些都该是小而清晰的改动，而不是 fork 整个项目 —— 代码可读、接缝是刻意留出来的。issue、PR、提问都欢迎。上手见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

Magister 会执行 shell 命令、连接可运行任意代码的 MCP 服务器；默认 `trustLevel: "ask"` 让每次 MCP 工具调用都过审批。Linux 上可选的 bubblewrap 沙箱提供尽力而为的隔离。Provider key 本地存储 —— 请用磁盘加密。安全模型面向单个可信操作者运行自己的 agent，不针对不可信或对抗性代码。漏洞披露见 [`SECURITY.md`](SECURITY.md)。

## License

[MIT](LICENSE)
