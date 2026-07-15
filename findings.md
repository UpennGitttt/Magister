# Findings

## Spec(已定死,不重新讨论)
- spec: docs/superpowers/specs/2026-07-14-trusted-progress-engine-design.md
- 信号流接口:sentinel.signal 写入 execution_events,digest 按时间窗查询
- 撤销语义:先执行后补偿;自动档准入 = 有精确反向操作;重跑 CI 归预览+确认
- 通知预算:per-channel 每日计数器,默认 3 条/天,超额合并进下一条 digest,digest 本身放行
- acted-on 观测口径 = Slack 按钮回调;纯文本投递不产生 acted-on

## Codebase(Phase 1 侦察结果,均已核对路径:行号)

### Loop 模式(照抄对象)
- `scheduled-task-service.ts:254-283`:`MAGISTER_SCHEDULER_ENABLED`(默认 true)、
  `_INTERVAL_MS`(默认 60s)、in-flight bool guard、await 首 tick、clearInterval stop
- server.ts 注册 :238(app.listen 后)、teardown onClose :189

### execution_events
- 写:`execution-event-repository.ts:21` `create(input)` 自动 seq;
  **无 taskId 系统级事件先例**:`memory-extractor-service.ts:26-50`(taskId nullable)
- type 惯例 `域.snake_case`:leader.decision_trace / goal.budget_exhausted / channel.outbound.delivered
- 查:`listByType(type, limit)` :59、`getLatestByType` :291;**type+时间窗 SELECT 不存在,要新增**
  `listByTypesSince(types, since)`(时间窗先例:task-retention-service.ts:258 的 DELETE)
- schema :258-287:id/type/requestId/taskId/workspaceId/severity/payloadJson/occurredAt/seq/traceId

### Slack(双向完整,无障碍)
- 出站:`integrations/slack/slack-client.ts:29` `postMessage({channel,text,threadTs?,blocks?})`
  **支持 blocks**;`updateMessage` 也有;工厂 `buildSlackClientIfConfigured(botToken)` :86
- 入站 interactivity:`slack-socket-gateway.ts:102-118` handleInteractiveEvent →
  `slack-router.ts:220` handleSlackBlockAction;**审批卡片先例** `sendApprovalCard` :156
  (envelope + 按钮 + chat.update 回写)——digest 按钮照这个模式加
- `deliver-slack-reply-service.ts:16`:任务回复形态(要 bindingId/taskId),
  digest 主动推送不走它,直接 slackClient.postMessage

### 一次性 LLM 调用先例(digest 生成用)
- `memory-extractor-service.ts:173-226`:resolveAgentForRole →
  `buildApiConfigFromAgent`(process-task-intent-service.ts:948,已导出)→
  `callStreamingApi`(streaming-api-caller.ts:780)for-await 拼 text_delta + AbortController 超时
- 已知 ceiling:这条路**不记 token usage**(/usage/today 不可见)——1 次/天可接受,代码注释标注

### MCP dispatch
- `mcp-pool-service.ts:365-370` dispatch(serverId, toolName, args, ctx?) ctx 可选属实;
  :411-422 untrusted + 无 taskId → isError 拒绝(fail-safe 天然成立)

### Config / 测试 / 预算
- 后台 worker 惯例 = 纯 env var(MAGISTER_ 前缀),不动 executors.json zod schema
- 测试样板:`apps/api/test/services/scheduled-task-service.test.ts`
  (bun:test,MAGISTER_DB_PATH 指向 temp sqlite,createDb 自动建表,直调 runXxxTick(now))
- 预算刹车 `process-task-intent-service.ts:1834` 只在 goal-loop hook 生效——
  digest 直调 callStreamingApi 完全绕开,spec 的"豁免"天然成立

### 侦察发现的坑
- noise-event 清理(task-retention-service.ts:258 NOISE_EVENT_TYPES)会按 TTL 删事件——
  sentinel.signal / digest.sent 不得进噪音名单
- 所有 startXxxLoop 首 tick 是 await 的——sentinel/digest tick 内部要快或 fire-and-forget

## 设计定案(ponytail 竖切)
- **按钮动作 = 创建任务**:点 [执行] → processTaskIntent(建议文本) → 完整 leader+安全栈接管。
  零新动作执行机制,RAIL 补偿机制 v1 不需要(动作由 leader loop 在既有审批门内做)
- **通知预算 = DB 当计数器**:数今天的 alert 事件(listByTypesSince),无新状态
- **digest 已发判定 = getLatestByType("digest.sent")**,无新表
- **MCP 巡查 v1 = 原样采集**:env 配 checks 列表,dispatch 结果原文入 signal payload,
  风险解读交给 digest 生成时的 LLM(不写映射引擎)
- 推送目标:env 配 MAGISTER_DIGEST_SLACK_CHANNEL / _FEISHU_CHAT_ID,配了哪个推哪个
