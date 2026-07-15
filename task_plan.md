# Task Plan: Trusted Progress Engine — MVP 实现

## Goal
按 `docs/superpowers/specs/2026-07-14-trusted-progress-engine-design.md` 实现 MVP:
巡查 worker(sentinel.signal 事件)→ 每日进度 digest(Slack 投递 + 交互按钮)→
acted-on 指标记录。写完代码 + 测试,typecheck + test 全绿。

## Scope 决策(ponytail:最小可测竖切)
- IN: sentinel 信号采集(内部信号 + config 驱动 GitHub MCP 读)、digest tick
  (聚合 → leader 生成 → channel 投递)、通知预算计数器、acted-on 事件记录
- IN(若 Slack Socket Mode 支持 interactivity): digest 按钮 + 回调
- OUT(本轮): RAIL 自动档补偿机制(无真实 GitHub 写场景无法验证)、Feishu 卡片、
  授权边界快照表

## Phases
- [x] Phase 1: 摸清代码接入点 → findings.md(无撞墙点;Slack 双向完整)
- [x] Phase 2: 写完整实现 plan(docs/superpowers/plans/2026-07-14-trusted-progress-engine.md,
      5 Tasks;分支 trusted-progress-engine off p0-hardening)
- [x] Phase 3: sentinel-service 完成(commits 5ec677d, 94cc2bf;repo 方法 + service + 6 测试全绿 + server 接线)
- [x] Phase 4: digest-service 完成(commit dd4c73c;聚合+生成+投递+6 测试全绿+server 接线)
- [x] Phase 5: acted-on 完成(commit 95a3737;handleDigestAction 按钮分支+4 测试全绿)
- [x] Phase 6: 全量验证(typecheck + test 3060 pass)+ code review 修复
      (I1 投递失败不推进窗口 / I2 operator 允许清单 / I3 失败路径测试 /
      M3 hour clamp / M5 section cap / M6 payload 守卫)+ commit + push + draft PR

## Key Decisions
- 信号流:巡查 tick 写 execution_events(type=sentinel.signal),digest tick 按时间窗查
- Slack 感知复用原生 Socket Mode,不接 Slack MCP;GitHub 走 MCP(config 驱动)
- Team = workspace;token 预算 only;digest tick 豁免预算刹车
- 分支:待 Phase 1 查明 PR #2 状态后定(feature branch off p0-hardening or main)

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
