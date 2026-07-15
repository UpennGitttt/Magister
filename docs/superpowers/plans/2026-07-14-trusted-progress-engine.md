# Trusted Progress Engine — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-07-14-trusted-progress-engine-design.md`
**Branch:** `trusted-progress-engine`(off `p0-hardening` HEAD 536d062 — PR #2 尚未合并,sentinel 依赖其审批/auth 加固,且新代码不得污染 PR #2)
**Goal:** sentinel 巡查采集信号 → 每日 digest(Slack Block Kit 按钮 / Feishu 纯文本)→ 按钮回调记 acted-on 并创建任务。全部 env-gated、默认关闭、fail-safe。

## 与 spec 的偏差(实现阶段决策,均已在 findings.md 论证)

1. **v1 无即时 L1/L2 告警推送** — 所有信号只进 digest(等价于通知预算=0:全部合并进 digest,spec §6 的降级行为)。即时告警 + 预算计数器 = 下一波,推送路径存在后才有东西可数。
2. **无签名校验 endpoint** — Slack Socket Mode 的 interactivity 走已建立的 WS,复用 `slack-router.ts` 的 block_actions 分发,不新建 HTTP endpoint。
3. **按钮动作 = 创建任务** — 点[执行] → `processTaskIntent(建议动作文本)`,完整 leader + 既有安全栈(审批/风险分类)接管执行。v1 不做 RAIL 补偿机制(无自动档动作可补偿)。
4. **digest 生成走 memory-extractor 先例**(resolveAgentForRole → buildApiConfigFromAgent → callStreamingApi 拼 text_delta)。已知 ceiling:这条路不记 token usage;1 次/天可接受,代码注释标注。

## Env vars(全部 MAGISTER_ 前缀,worker 惯例)

| Var | Default | 用途 |
|---|---|---|
| `MAGISTER_SENTINEL_ENABLED` | `false` | sentinel loop 开关(spec: off by default)|
| `MAGISTER_SENTINEL_INTERVAL_MS` | `300000`(5min)| 巡查间隔 |
| `MAGISTER_SENTINEL_STALL_MS` | `1800000`(30min)| runtime 停滞阈值 |
| `MAGISTER_SENTINEL_MCP_CHECKS` | `""`(无)| JSON 数组:`[{"serverId","toolName","args","label"}]`,只读巡查 |
| `MAGISTER_DIGEST_ENABLED` | `false` | digest loop 开关 |
| `MAGISTER_DIGEST_HOUR` | `9` | 本地时区,每天该小时后首个 tick 发送 |
| `MAGISTER_DIGEST_SLACK_CHANNEL` | `""` | 配置则 Slack Block Kit 投递 |
| `MAGISTER_DIGEST_FEISHU_CHAT_ID` | `""` | 配置则 Feishu 纯文本投递(无按钮,不计 acted-on)|

## 新事件类型(域.snake_case;均不得进 NOISE_EVENT_TYPES)

- `sentinel.signal` — payload: `{signalType: "stalled_runtime"|"approval_overdue"|"risk_event"|"mcp_check", ref, summary, fingerprint}`;taskId 可空(memory.extractor_error 先例)
- `digest.sent` — payload: `{channel: "slack"|"feishu"|"none", itemCount, messageTs?}`
- `digest.action_taken` / `digest.action_dismissed` — payload: `{actionText, taskId?, slackUserId}`

---

## Task 1: `listByTypesSince` repository 方法

**Files:** modify `apps/api/src/repositories/execution-event-repository.ts`;
test `apps/api/test/repositories/execution-event-repository.test.ts`(已存在,加 case)

- `listByTypesSince(types: string[], since: Date, limit = 500)` — `inArray(type) + gte(occurredAt, since)`,occurredAt+seq 升序(时间窗模式照 task-retention-service.ts:258 的 DELETE)
- 测试:seed 3 类事件、2 个时间点,断言窗口过滤 + type 过滤 + 排序

## Task 2: sentinel-service(信号采集)

**Files:** create `apps/api/src/services/sentinel-service.ts`;
create `apps/api/test/services/sentinel-service.test.ts`;
modify `apps/api/src/server.ts`(register :238 区、teardown :189 区)

结构照抄 `scheduled-task-service.ts:246-283`:module 级 timer + inFlight bool,`startSentinelLoop`/`stopSentinelLoop`,await 首 tick。

`runSentinelTick(now)`(导出纯函数,直调测试):
1. **stalled runtimes**:role_runtimes 中 RUNNING 且 `updatedAt < now - STALL_MS`(runtime-recovery-service 同款信号)
2. **overdue approvals**:`ApprovalRepository.listExpired(cutoff)`(既有方法)
3. **risk events**:`listByTypesSince(["leader.doom_loop_detected","goal.budget_exhausted"], since=上个 tick 窗口)`
4. **MCP checks**:解析 `MAGISTER_SENTINEL_MCP_CHECKS`,逐个 `getMcpPool().dispatch(serverId, toolName, args)`(无 ctx → untrusted 天然被拒 = fail-safe);结果原文入 payload,解读交给 digest LLM
5. **dedup**:查当天已有 `sentinel.signal` 的 fingerprint 集合,重复不写
6. 每个新信号写一条 `sentinel.signal` 事件(无 taskId)

全程 try/catch per-source:单源失败 log 继续,tick 永不 throw(fail safe never loud)。

测试(样板 scheduled-task-service.test.ts:temp sqlite + 直调 tick):
- seed 停滞 runtime + 过期 approval → tick → 2 条 sentinel.signal,payload 正确
- 同 seed 再 tick → 0 新增(dedup)
- MCP checks env 为空/坏 JSON → 不 throw
- 健康 runtime / 未过期 approval → 0 信号

## Task 3: digest-service(聚合 + 生成 + 投递)

**Files:** create `apps/api/src/services/digest-service.ts`;
create `apps/api/test/services/digest-service.test.ts`;
modify `apps/api/src/server.ts`

Loop:interval 10min 检查,`now.getHours() >= DIGEST_HOUR` 且 `getLatestByType("digest.sent")` 不是今天 → 跑 `runDigestTick(now)`。

`runDigestTick(now)`:
1. **聚合**:`listByTypesSince(["sentinel.signal"], since=上次 digest.sent 或 24h)` + 窗口内完成/失败的 tasks(tasks 表 status+updatedAt 查询)
2. **生成**(可注入 generator 以便测试):memory-extractor 先例组 prompt,要求输出 JSON `{items: [{kind: "progress"|"stuck"|"decision", text, ref?, suggestedAction?}]}`;解析失败 → 降级为原文纯文本 digest(不丢)
3. **投递**:
   - Slack 配置了 → `slackClient.postMessage({channel, text: fallback, blocks})`。blocks:header + 每 kind 一个 section;带 `suggestedAction` 的条目附 actions block,按钮 `action_id: "digest_act"` / `"digest_dismiss"`,`value: JSON.stringify({actionText})`(照 sendApprovalCard :156 形态)
   - 否则 Feishu 配置了 → 纯文本(无按钮)
   - 都没配 → 只记事件(channel: "none")
4. 写 `digest.sent` 事件
5. 无信号且无任务变化 → 仍发一条极短"一切安静"digest?**否**——零条目则跳过投递、只记 digest.sent(channel:"none"),避免噪音

测试:
- seed 信号 + 完成任务,注入 fake generator(返回固定 JSON)+ fake slack client → 断言 blocks 结构(含按钮 value)+ digest.sent 事件
- generator 返回坏 JSON → 纯文本降级投递,不 throw
- 今天已有 digest.sent → tick no-op
- 零素材 → 不投递,digest.sent(channel:"none")

## Task 4: acted-on(Slack 按钮回调)

**Files:** modify `apps/api/src/services/slack/slack-router.ts`(handleSlackBlockAction :220 区);
create `apps/api/test/services/digest-action.test.ts`

- `handleSlackBlockAction` 现有分发中加 `digest_act` / `digest_dismiss` 两个 action_id 分支:
  - `digest_act`:parse value → 写 `digest.action_taken` 事件 → `processTaskIntent`(以 Slack 渠道既有 intake 形态提交 actionText 为新任务)→ `chat.update` 原消息标记"✅ 已安排(task <id>)"
  - `digest_dismiss`:写 `digest.action_dismissed` → `chat.update` 标记"已忽略"
- acted-on 查询接口 v1 不做(事件在 DB,SQL 可查;做 endpoint = YAGNI)

测试:构造 block_actions payload 直调 handler(mock slack client + spy intent):
- digest_act → 事件写入 + intent 调用 + chat.update
- digest_dismiss → 事件写入 + 无 intent
- 坏 value JSON → 不 throw,记 error log

## Task 5: 接线收尾 + 文档 + 全量验证

- server.ts:两个 loop 注册(listen 后)+ onClose teardown,照 :238/:189 现有排列
- `docs/modules/trusted-progress-engine.md`:简短模块文档(架构图 + env vars + 事件类型)
- `docs/status/master-tracker.md`:加一行(CLAUDE.md 惯例要求)
- `bun run typecheck && bun run test`(pre-commit gate);逐 Task commit(feat: 前缀)
- push + draft PR(base: p0-hardening 未合并 → PR base 选 p0-hardening,合并后可 retarget main)

## 验收清单

- [ ] typecheck 绿
- [ ] 新增 4 个测试文件/用例组全绿,既有测试不回归
- [ ] 两个 loop 默认关闭,env 开启后 server 启动注册、关闭时 teardown
- [ ] sentinel.signal / digest.sent 不在 NOISE_EVENT_TYPES
- [ ] digest 零配置(无 Slack/Feishu)时不 crash,只记事件
