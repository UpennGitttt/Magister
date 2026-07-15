# Trusted Progress Engine — 设计 spec

> **定位:** 唯一一个你敢让它**动手**的 AI manager。
> 它接入团队真实干活的地方(GitHub + Slack),持续维护"团队现在到底在
> 发生什么",然后主动产出进度摘要、发现停滞和 blocker,并在安全可逆的
> 边界内替你处理——你只在真正重要的决定上点一下。

**日期:** 2026-07-14
**状态:** DESIGN — 待用户 review,通过后进 writing-plans
**关系:** 本 spec **重定位** `2026-07-13-proactive-risk-sentinel-design.md`
(下称 sentinel spec):把定位从"看住风险"改为"可信进度引擎",把
GitHub+Slack 感知 + 进度 digest 提为头条,风险哨兵/回滚/预算刹车降为
其周围的安全脚手架。sentinel spec 的架构 80% 沿用,理由和重心按本 spec 修正。
**依赖:** P0 hardening(PR #2)已交付的安全底座之上。

---

## 1. 为什么是这个(research 结论,诚实标注)

两路 research(startup 采用痛点 + 竞品格局 + 107-agent deep-research,
3-vote 对抗验证)收敛出以下结论。置信度逐条标注。

### 已验证的用户痛点(High,一手源 / 具名事件)

eng manager 的核心痛点**全部发生在团队真实用的工具里**,不在 Magister 内部:

1. **"更新死在 thread 里,blocker 藏在 DM"** —— 信息散落,manager 不知道真实进度。
2. **"standup 没人交 / agent 跑了几小时没人管 / PR 状态没人知道"** —— 停滞和风险无人主动发现。
3. **"知道'在忙'容易,知道'到底在发生什么'难"** —— 感知缺失。
4. **手动写周报 / 追人问进度** —— 重复的低价值 manager 杂活吃时间。

痛点 1–4 的发生地 = **GitHub(PR/CI/issue)+ Slack(thread/DM)+ 聊天**。
这直接决定了 MVP 的感知源必须包含 GitHub 和 Slack(见第 4 节)。

### 死亡模式(High,具名)

- **Height**($18.3M,唯一号称 autonomous PM 的工具,2025-09 关停):自主功能
  demo 惊艳,但用户第三周就关掉了。**死在"动手",不是死在"感知"。**
- **Devin**:20 个真实任务成功 3 个;自主性本身成了负债(Cognition 仍以
  $10.2B 估值融 $400M,ARR $1M→$73M)。
- **通知疲劳**(High,2 独立源):用户每天能容忍约 3–5 条主动更新,疲劳
  滞后于参与度指标数周才显现。→ 直接决定北极星指标是 **acted-on 不是 sent**(第 8 节)。

### 红海与墓地(High)

- **感知层是红海**:Bond(YC Spring 2025,几乎一模一样:Pattern Radar +
  Presidential Brief)、Dailybot(YC)、General Intelligence($8.7M seed)、
  Quill($6.5M,Naval)。上面还压着 Glean($7.2B,~$200-300M ARR)和
  Microsoft Copilot(~$5B 营收,90% Fortune 500)。
- **KB / ingestion 是 commodity**,不是护城河。
- **行动层是墓地**:所有试图让 AI 动手的都死在第三周;活着的竞品都是
  "感知优先、不敢动手"的 3 人 dashboard 公司。

---

## 2. 护城河 / 投资人叙事

> 本节是产品定位 / 融资叙事,**非实现依据**;工程约束见第 3 节起。

> **market 已经证明了两件事:所有人都想要一个能"动手"的 AI;而所有
> 试图让它动手的人,都在第三周被用户关掉了。我们从他们停下的地方开始。**

别人告诉你"这个 PR 卡了";我们是唯一一个你**敢真让它去 nudge reviewer /
改 label / 改 assignee** 的——因为每个动作都 **Reversible / Authorized /
Interruptible / Logged**(RAIL,第 7 节),越界的有工具层硬上限。

### 护城河候选(诚实排序)

| # | 候选 | 性质 | 评级 |
|---|---|---|---|
| **1** | **信任校准数据** —— 每个团队的审批规则 + 授权边界,累积成"这个团队允许 AI 无监督做什么"的私有 per-team 模型。用得越久越准。 | 复利 + 切换成本 + 数据三合一 | **最强(Medium-High)** |
| 2 | **安全执行底座** —— 约一年的硬化工作(4 级风险分类器 + 审批状态机 + doom-loop 阻断 + 回滚 + execution_events 审计 + bubblewrap 沙箱 + command_approval_rules) | 可复制,但 dashboard 老玩家得去建他们**故意回避**的那块(动手=担责)。先发时间差,非永久壁垒 | 中(Medium) |
| 3 | 感知+行动全闭环在一个产品里 | 单独弱,但抬高切换成本 | 弱(Low-Medium) |

**核心是 #1 的信任飞轮**:每一次它安全地完成一个动作 → 用户给它更多自主权 →
更多动作 → 更多"什么是安全的"数据 → 校准更准 → 用户更敢放手。这个循环
别人从零启动要 per-team 重新跑一遍。这是投资人爱听的 compounding loop。

**护城河不是"我们有安全代码"(那是 feature),是这个越用越敢放手的信任飞轮。**

### 反驳投资人会 pass 的点

1. *"安全 infra 是 Copilot/Glean 顺手 bolt-on 的 feature。"* → 他们优化企业级
   广度,不是自主动手;行动层对他们是有动机**不发**的 risky 产品(担责)。往
   执行引擎上加 dashboard,比往 dashboard 上加安全执行底座容易得多——而我们
   天生是执行引擎+安全底座,往上加感知。
2. *"Bond/Dailybot 同楔子 + 有钱。"* → 他们感知优先;给 dashboard 事后加可信
   执行底座,比我们现在这个位置难。
3. *"通知疲劳杀掉 digest 楔子。"(这条是真的)* → 所以北极星指标从第一天就是
   **acted-on 不是 sent**;顺带证明价值在"行动"不在"播报"。

### 最大未验证假设(Medium → 要 MVP 去证)

"信任飞轮真能跑起来"——即**用户真的会随时间给 AI 更多自主权**——目前是
**假设,未验证**。这是 MVP 要证明的第一件事,也是把整体信心从 Medium 抬到
High 的关键实验(见第 8 节 acted-on 指标 + 授权范围随时间变化的追踪)。
注意:N=1(自用)的撤销率/授权变化不构成可信证据,飞轮验证需要 ≥ 数个
真实团队的数据;自用阶段的数据只当烟测。

---

## 3. 全局约束

- **Reuse over rebuild.** GitHub 感知走现成 MCP,Slack 感知复用原生集成;
  引擎照抄 `scheduled-task-service.ts`;回滚/刹车/plan-mode 门复用 sentinel
  spec 已定的既有 plumbing。新建的只有:digest 生成、Slack 交互按钮 + 回调
  endpoint、撤销(补偿)机制、acted-on 指标。每处新建显式标注。
- **Reversible-only autonomy.** 自动执行仅限可逆动作 + 撤销窗;外发/批量要
  预览确认;不可逆动作工具层硬上限。详见第 7 节。
- **No hardcoded servers / channels.** 巡查哪些 MCP server、调哪些工具、推到
  哪个 channel,全 config 驱动。无 MCP、无 channel 绑定的用户仍得到可用产品
  (仅内部信号 + 无外推)。
- **Env-gated, off by default.** 新后台 worker 沿用 `scheduled-task-service.ts`
  模式:flag + interval + in-flight guard + 启动即一次 tick。
- **Fail safe, never fail loud.** 巡查 tick 出错只 log + reset,绝不中断任务或
  crash server;MCP/channel 推送 best-effort。
- **Token budget only, not USD.** price table 已删、`costUsd` 恒为 null →
  只做 token 预算,UI 文案不得暗示美元。
- **Team = workspace(MVP)。** 本 spec 所有"团队级 / per-team"均指
  workspace。不建 users/teams 表——单用户产品阶段建多租户模型是过度设计。

---

## 4. MVP 边界

### IN(必需)

| 层 | 内容 | 状态 |
|---|---|---|
| **感知** | GitHub(PR/CI/issue)+ Slack(thread/DM)+ Magister 自己 agent 的活 | GitHub **复用现成 MCP**(Settings 加 server,近零新代码);Slack **复用原生 Socket Mode 集成**(已存在,不走 MCP)。痛点就在这两个源,所以**必需非可选** |
| **引擎** | 巡查 worker 读上述信号 → 分级 L1 通知 / L2 建议 / L3 可回滚刹车 | sentinel spec 已定,照抄 `scheduled-task-service.ts` |
| **行动** | 第一个楔子 = 主动的每日/每周**进度 digest**(含交互按钮);越界写操作走 RAIL | digest + 按钮/回调 **新建**(第 6 节);RAIL 门/回滚/刹车部分已在 sentinel spec |

### OUT(YAGNI / 保护护城河)

- ❌ **email / meeting bot**(Recall/Vexa/邮箱身份):真痛点,但对 eng manager
  不如 GitHub/Slack 高频,且是真·净新集成 —— **下一波**。
- ❌ **supermarket / 工具聚合平台**:已否决——杀护城河、无楔子、无留存。
- ❌ **美元预算**:price table 已删,只做 token 预算。
- ❌ 向量/embedding 检索:与 memory/journal 子系统决策一致,FTS5 BM25 够用。

### Scope check(writing-plans 时执行)

本 spec 覆盖三个可独立交付的子系统:(a) GitHub/Slack 感知接入 + 巡查扩展,
(b) 进度 digest 生成 + 投递,(c) acted-on 指标 + RAIL 行动门。writing-plans
阶段应据此**拆成独立 plan**,每个都能单独产出可测软件。sentinel spec 的
风险哨兵/回滚/刹车若尚未实现,是它们各自的 plan,不在本 spec 重复。

---

## 5. 三层架构

```
┌─────────────────────────────────────────────────────────┐
│  感知层   GitHub MCP · Slack 原生集成 · 自身 agent 活        │  ← 全部复用既有
│           getMcpPool().dispatch(server, tool, args, ctx?)  │
└────────────────────────┬────────────────────────────────┘
                         │ 只读信号
┌────────────────────────▼────────────────────────────────┐
│  引擎层   巡查 worker（照抄 scheduled-task-service.ts）      │  ← sentinel spec
│           收集信号 → 分级 L1/L2/L3 → 记 execution_event     │
└────────────────────────┬────────────────────────────────┘
                         │ 结构化风险/进度事件
┌────────────────────────▼────────────────────────────────┐
│  行动层   进度 digest（新）  +  RAIL 门（回滚/刹车已有）      │
│           越界动作按 RAIL 分级：自动+撤销 / 预览确认 / 硬上限 │
└──────────────────────────────────────────────────────────┘
```

### 5a. 感知层 —— GitHub via MCP,Slack 复用原生集成

- **GitHub:** Magister 已有 MCP pool、per-agent attachment、
  `getMcpPool().dispatch(serverId, toolName, args, ctx?)`(`ctx` 可选,后台
  worker 可调)。GitHub 有官方 MCP server → 接入 = "Settings → MCP → Add",
  不是净新子系统。
- **Slack:** Magister **已有原生 Socket Mode 双向集成**(能收发消息)。感知
  复用它,**不接 Slack MCP**——否则两套 Slack auth、两个集成并存,徒增维护
  面。"近零新代码"这个说法只对 GitHub 成立;Slack 侧的新工作是把已收到的
  消息流映射成巡查信号(下方信号映射),量小但非零。
- **硬约束(sentinel spec 已验证):** worker 无 `taskId`,若 server `trustLevel`
  要审批则**按设计被 block**。所以感知只用 trusted / 只读工具;启用写动作
  (PR comment、改 assignee)要 operator 在 Settings 显式标 trusted —— 一次性
  授权,非默认。
- **信号映射**(config 驱动,不 hardcode):
  - GitHub:PR 卡在 review 超 N / CI failing / issue 未 assign → L1 或 L2。
  - Slack:@提及未回超 N / thread 里问题悬而未决 → L1。
  - Magister 自身:role_runtime 停滞、审批超时、doom-loop → 沿用 sentinel spec 既有检测。

### 5b. 引擎层 —— 巡查 worker

完全沿用 sentinel spec 的 `sentinel-service.ts` 设计(`startSentinelLoop` /
`runSentinelTick` / 分级响应 / 去重指纹)。本 spec **不重复**其内部细节,只
新增一件事:巡查结果除了推 L1/L2/L3 告警,还**喂给 digest 生成器**(5c)。

**信号流接口(巡查 → digest,本 spec 定死,plan 不得另行发明):**
巡查 tick 把每个信号写成 `execution_events` 事件(新事件类型,如
`sentinel.signal`,payload 含:信号类型、来源引用 PR#/thread 链接、风险等级、
去重指纹)。digest tick 按时间窗查询这些事件作为素材。理由:复用已有的
投影/审计/WS 广播,零新表,重启不丢;两个 tick 各自独立调度,靠 DB 解耦。

### 5c. 行动层 —— 进度 digest(第一个楔子,详见第 6 节)+ RAIL 门(第 7 节)

---

## 6. 第一个楔子:主动进度 digest

**这是 MVP 的头条可见价值**,也是新建的核心。

### 目标

一个 eng manager 早上打开 Slack,看到一条 Magister 主动发来的 digest:
"昨天团队推进了什么、什么卡住了、什么需要你今天决定"——不用他去追人、翻
thread、看 dashboard。

### 数据来源(全部复用,不新采集)

| 素材 | 来源 |
|---|---|
| PR / CI / issue 动态 | GitHub MCP(5a)|
| 讨论 / 悬而未决问题 | Slack 原生集成(5a)|
| Magister agent 完成/停滞/超预算 | `execution_events` / `role_runtimes` / `tasks`(既有)|
| 风险告警 | 巡查 worker 的 L1/L2/L3 输出(5b)|

### 生成方式(复用 leader,不新建 LLM 管线)

- 一条 scheduled tick(复用 `scheduled-task-service.ts` 的 cron 基建,journal
  spec 已验证此路)按 config 的 cadence(默认每日,可配每周)触发。
- tick 汇集上述素材 → 走 leader 一次生成结构化 digest → 按 RAIL 投递。
- digest 是**结构化对象**(不是纯文本),每个条目带:类型(进展/停滞/需决定)、
  来源引用(PR#、thread 链接)、可选的**建议动作**(如"nudge reviewer?")。
  建议动作是 acted-on 指标(第 8 节)的锚点。

### 投递:交互按钮(净新工程,MVP 只做 Slack)

现有投递路径 `deliverLeaderAnswerToFeishu/Slack` 推**纯文本**——用户看到
"要不要 nudge reviewer?"后自己手动去做,acted-on **不可观测**。北极星指标
依赖可点的按钮,所以这块新钱必须花,但砍到最小:

- **MVP 只做 Slack**:digest 用 Block Kit 交互消息(按钮带 action_id +
  digest 条目引用),新增一个按钮回调 endpoint(Slack interactivity payload
  → 校验签名 → 记 acted-on 事件 → 触发对应动作走 RAIL 门)。
- Feishu 卡片按钮**下一波**;Feishu 用户 v1 收纯文本 digest(无按钮,
  acted-on 不统计)。
- 文本投递路径保持不动,按钮消息是 Slack 侧新增的发送形态。

### 通知预算(硬约束,有 enforcement)

fingerprint 去重防的是**重复**,不防**总量**。新增 per-channel 每日主动推送
计数器:超过预算(默认 3 条/天,env 可配)的 L1/L2 告警**不丢弃**,合并进
下一条 digest。digest 本身每天 1 条,始终放行。

### 明确不做(v1)

- 不做 Web UI digest 页面(Slack/Feishu 就是投递面)。
- 不做每人个性化 digest(先团队级一条)。
- 不做 digest 的历史归档检索(若需要,复用 journal 子系统,单独的事)。

---

## 7. RAIL 信任模型(行动层的门)

行动分三档,**门在工具层强制,不在 prompt**:

| 档 | 场景 | 行为 | 已有 / 新建 |
|---|---|---|---|
| **自动 + 撤销窗** | **有精确补偿操作**的内部动作(加/删 label、改 assignee) | **先执行后补偿**:立刻执行,推一条带 [撤销] 按钮的通知;窗内点撤销 = 执行反向操作 | **新建**补偿机制(每个自动档动作注册其反向操作) |
| **预览 + 确认** | 外发 / 批量 / 无补偿操作(发消息、PR comment、批量 nudge、**重跑 CI**) | 生成预览,人点确认才发 | 复用现有审批状态机(`command-approval-service.ts`)|
| **硬上限** | 不可逆(删除、force push、mass action) | 工具层硬拦,无 override | 复用 4 级风险分类器 CRITICAL 档 + `command_approval_rules` |

**撤销窗语义(定死):先执行后补偿,不做延迟执行队列**(持久化队列 + crash
recovery 是一个新子系统,YAGNI)。由此自动档的准入标准 = **该动作存在精确
反向操作**。"重跑 CI"没有补偿操作(跑了就是跑了),归"预览+确认"档。

**RAIL 与护城河的连接**:用户对每档动作的授权选择(哪些自动、哪些要确认)
就是第 2 节信任校准数据的原料。MVP 要**记录并随时间追踪**每个团队的授权
边界如何变化——这既是产品行为,也是验证信任飞轮假设的实验数据。

### 硬边界(诚实标注)

- 撤销窗对**真正不可逆**的动作无意义(邮件发出去撤不回)——所以不可逆动作
  永远走"硬上限"档,不走"自动+撤销"。分类由现有 4 级风险分类器判定。
- MVP 的自动档只覆盖**有精确补偿操作的 GitHub 内部动作**(label/assignee)。
  发消息类一律至少"预览+确认"。
- digest 生成走 leader,消耗 token——digest tick 的调用**豁免预算刹车**
  (或有独立小额预算),避免"预算刹停 → digest 停发 → 用户失去可见性"的
  自锁。plan 里落实现。

---

## 8. 北极星指标:acted-on 不是 sent

- 通知疲劳(High)决定:衡量**被采纳的动作数**,不是发出的通知数。
- **观测口径 = Slack 按钮回调**(第 6 节):点 [执行] = 采纳,点 [撤销] =
  撤销,窗口过期无操作 = 默许。纯文本投递(Feishu v1)不产生 acted-on 数据。
- 每条 digest 建议动作 / 每个 L2 建议,记录:是否被用户采纳、采纳延迟、
  是否被撤销(自动档)。
- **信任飞轮的验证信号**:随时间,(a) 用户把多少动作从"预览确认"降级为
  "自动+撤销",(b) 自动档动作的撤销率是否下降。这两条是第 2 节最大未验证
  假设的直接度量——MVP 跑几周后能把整体信心从 Medium 抬到 High 或证伪。
- 复用 `execution_events` 记录,新增动作结果的事件类型;聚合复用 `/usage`
  类端点的模式。**per-team 授权变化**需要一处新的轻量记录(授权边界快照)。

---

## 9. 与 sentinel spec 的差异摘要

| 维度 | sentinel spec(旧) | 本 spec(新) |
|---|---|---|
| 定位 | "看住风险"的 AI manager | "可信进度引擎",敢动手 |
| GitHub | 5 个巡查源之一 | 与 Slack 一起是**必需感知源**,痛点所在 |
| digest | 开放项 #4 | **第一个楔子,头条** |
| 白空间论断 | "主动 manager persona 无人做" | **推翻**——已挤满(Bond/Dailybot);真差异在"敢动手" |
| 护城河 | 未明确 | **信任校准数据 > 安全底座**(第 2 节)|
| 指标 | 未明确 | **acted-on**(第 8 节)|
| 风险哨兵/回滚/刹车 | 头条三组件 | 降为 digest 周围的**安全脚手架** |

sentinel spec 的技术设计(检测源表、分级响应、回滚端点、预算刹车、测试策略)
**继续有效**,本 spec 引用不重抄。若 sentinel spec 尚未进 writing-plans,其
组件与本 spec 的 digest 在同一批 plan 里协调实现。

---

## 10. 测试策略(高层;plan 细化)

- **感知**:mock 一个 trusted GitHub MCP server,断言巡查 dispatch 只读工具,
  把"PR 卡 review"结果映射为 L1;断言 untrusted server 的工具被拒(无 taskId)。
- **digest**:seed 一个含 PR 动态 + 停滞 runtime + 完成任务的 DB,跑一次 digest
  tick,断言产出结构化 digest 含三类条目 + 来源引用;断言按 cadence 触发、
  遵守去重。
- **RAIL 自动+撤销**:触发一个可逆动作,断言撤销窗内可撤销、超时后生效、
  两者都记 execution_event。
- **RAIL 硬上限**:不可逆动作断言被工具层硬拦、无 override。
- **acted-on 指标**:模拟采纳/撤销/忽略,断言事件正确记录、授权边界快照更新。

---

## 11. 开放项(留给 writing-plans)

1. digest cadence 默认值与可配范围(每日 / 每周 / 事件驱动阈值)。
2. GitHub/Slack 信号 → 风险等级的映射表具体形态(config shape)。
3. RAIL 自动档撤销窗时长(30–120s 区间取值,env 可配)。
4. per-workspace 授权边界快照的存储形态(新表 or 复用
   command_approval_rules 扩展)。
5. digest 结构化对象的 schema(条目类型、来源引用、建议动作字段),及
   `sentinel.signal` 事件的 payload schema。
6. Slack 按钮回调 endpoint 的签名校验与 payload 解析细节(Slack
   interactivity 标准流程)。
7. digest tick 的 token 预算豁免 / 独立小额预算的实现方式。
8. 本 spec 与 sentinel spec 组件在 writing-plans 的 plan 拆分与先后顺序。
