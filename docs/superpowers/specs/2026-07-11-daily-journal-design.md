# Daily Journal（每日知识库）设计

日期：2026-07-11
状态：待用户审阅
背景任务：把 Magister 升级为个人 AI manager 框架。brainstorm 确定的内核是「每日知识库」——记录用户每天做了什么，Obsidian 式，后期可扩展 speech-to-text 输入。

## 目标与非目标

**目标（v1 成功标准）**

1. 每天一篇 daily note（`YYYY-MM-DD.md`），内容来自三条写入路径：任务自动归档、用户随手记、23:00 自动日报整理。
2. 文件是纯 markdown + `[[wikilink]]`，Obsidian 把 journal 目录当 vault 直接打开就能用。
3. 能问：用户在 Slack/Web 问「我上周二干了什么」「这个月花了多少 token」，leader 通过 journal 检索工具回答。

**非目标（v1 明确不做）**

- speech-to-text（未来形态：语音消息 → 转文字 → 同一条随手记路径，写入侧接口已为此预留）
- 周回顾 / 月回顾 cron（v2：cron 基建已现成，加一条 scheduled_task 的事）
- Web UI Journal 页面（Obsidian 就是阅读器）
- 向量/embedding 检索（FTS5 BM25 够用，与 memory 子系统的决策一致）
- 多用户、多 vault

## 方案选型（已确认：方案 A）

- **A. 平行 Journal 子系统（选定）**：独立目录 + 独立 FTS 表 + 独立 leader 工具。复用 memory 子系统的成熟模式（原子写、FTS 镜像、启动 backfill），但不共享其 schema 约束。
- B. 塞进现有 memory（新增 journal type）：全套复用，但要放宽 8KB body cap、scope/type/name 路径 shape、严格 frontmatter 校验、aging 标记等多处核心约束，回归风险最高，被否。
- C. 纯 prompt 零代码（cron + write_file）：最快但无 FTS 检索、格式会飘，支撑不了「能问」，被否。

选 A 的核心理由：journal 与 memory 的设计目标相反——memory 是「小而精、为 prompt 注入优化、严格校验」，journal 是「长内容、按天组织、容忍用户手改」。硬合并两者会互相伤害。

## 存储布局

```
~/.magister/journal/            ← MAGISTER_JOURNAL_DIR 可覆盖；user scope，跨项目
  daily/
    2026-07-11.md
    2026-07-12.md
```

单篇 daily note 结构：

```markdown
---
date: 2026-07-11
---

## Summary
（23:00 日报 cron 生成，整理后的当日总结；生成前此节不存在）

## Log
- 09:14 [task] 修复 Slack 审批卡超时泄漏 — completed，4m12s（web）
- 10:02 [note] 刚开完 X 项目周会，决定下周先做 [[数据迁移]]
- 14:30 [task] research：竞品调研报告 — completed，18m（slack）
```

规则：

- 「一天」的边界用 API server 本地时区（与 scheduled_tasks 的 cron 语义一致），文件名和 `date` frontmatter 均按此计算。
- `## Log` 是 append-only 的原始流水，Magister 只追加、永不重写；用户在 Obsidian 里手动编辑任何内容都不会被覆盖。
- `## Summary` 是 23:00 cron 唯一允许重写的区块（按标题定位替换）。
- 正文允许 `[[wikilink]]`，Magister 不解析语义、只原样保留（Obsidian 负责渲染和图谱）。
- **宽松解析**：frontmatter 缺失/非法不报错，找不到 `## Log` 就在文件末尾补一个。这是与 memory 严格校验的关键差异——用户手改文件永远不能让系统炸。
- 无 body cap（memory 的 8KB 上限是为 prompt 注入设计的，journal 不整篇注入 prompt，不需要）。
- 无 aging/stale 标记——日记天然按时间归档，旧不等于过期。

## 写入路径（三条）

1. **`journal_log(text, at?)`**（leader 工具）——随手记。用户在任何渠道说「记一下：刚开完 X 会」，leader 调用后向今天的 `## Log` 追加一条 `- HH:MM [note] <text>`。`at` 可选，支持补记（「昨天下午我修了打印机，帮我记上」）。这也是未来 speech-to-text 的落点：语音转文字后走同一工具。
2. **任务自动归档**（无 LLM、纯代码 hook）——task 到达终态时追加一条 `- HH:MM [task] <title> — <state>，<耗时>（<渠道>）`。挂在任务终态转换处，失败静默降级（journal 写不进不能影响任务本身）。日报任务自己（`createdBy: schedule:*` 且 prompt 是日报模板的）不归档，避免自我记录循环。
3. **23:00 日报 cron**（内置 scheduled_task，启动时 seed、幂等、用户可在现有 Schedules UI 里改时间或停用）——prompt 让 leader：读当天 `## Log` 原始流水 + `/tasks/stats`、`/usage/today` 聚合，改写成一段人话总结（今天主线、产出、异常、token/成本），写入 `## Summary` 区块。当日无任何条目则跳过。

## 检索（「能问」）

- **`search_journal(query, from?, to?)`**（leader 工具）——FTS5 BM25 全文检索，返回命中日期 + 匹配段落。日期范围可选。
- **`read_journal(date)`**（leader 工具）——读某天全文，支持 `today`/`yesterday` 快捷值。
- FTS 镜像沿用 memory-search-service 的模式：`journal_search` 表是磁盘文件的 best-effort 镜像，每次写入后更新，启动时 backfill（扫描目录重建），镜像损坏可随时重建，磁盘文件永远是唯一权威。用户在 Obsidian 手改的内容在下次 backfill/重建时进入索引（v1 不做文件 watcher，接受这个延迟）。
- **不做每 turn prompt 注入**（区别于 memory 的 `<memories>` 块）：journal 靠按需工具检索，避免撑爆上下文预算。leader 系统提示里只加一句工具用途说明。

## 组件与文件

| 组件 | 位置（新建） | 职责 |
|---|---|---|
| journal-fs-service | `apps/api/src/services/journal/journal-fs-service.ts` | 路径解析、宽松解析、原子 append、Summary 区块替换 |
| journal-search-service | `apps/api/src/services/journal/journal-search-service.ts` | FTS5 表、写后更新、启动 backfill |
| journal-leader-tools | `apps/api/src/services/journal/journal-leader-tools.ts` | journal_log / search_journal / read_journal 三个工具定义 |
| task 归档 hook | 任务终态转换处小改（复用现有事件/状态机入口） | 终态 append 一条 [task] 流水 |
| 日报 seed | server 启动路径 | 幂等 seed 内置 scheduled_task（`0 23 * * *`） |
| schema | `packages/db/src/schema.ts` + migration | `journal_search` FTS5 虚表 |

工具注册进 manager-tools-adapter.ts（仅 leader，teammate 不注册——与 memory 工具同姿势）。

## 错误处理

- 用户手改文件导致解析异常 → 宽松解析兜底，最坏情况当纯文本 append 到文件末尾。
- journal 写入失败 → 任务归档 hook 静默降级 + warn 日志；journal_log 工具向 leader 返回错误文本（leader 可告知用户），不 throw。
- FTS 镜像与磁盘不一致 → 磁盘为准，backfill 重建。
- 并发 append → 复用原子写（temp + rename）模式；单 API 进程内串行化同文件写入。

## 测试

- journal-fs：append 到已有/不存在文件、frontmatter 非法容忍、Summary 区块替换不触碰 Log、手改文件后再 append 不丢内容。
- journal-search：写入即可检索、日期范围过滤、backfill 幂等。
- task 归档 hook：终态触发、日报任务不自我归档、写入失败不影响任务状态。
- 日报 seed：幂等（重启不重复建）、用户改过的 schedule 不被覆盖。
- 工具层：journal_log 补记 `at`、read_journal 快捷值。

## 已知取舍

- Obsidian 手改内容进入 FTS 有延迟（等下次 backfill）——v1 接受，v2 可加文件 watcher。
- 任务归档只记 title + 状态（title 是 prompt 前 200 字，非 AI 摘要）——「任务最终回答说了什么」的语义摘要靠 23:00 日报补齐（leader 生成 Summary 时可回看任务详情），不在 tasks 表加 summary 字段（留作独立改进项）。
- execution_events 有 30 天 TTL——journal 文件本身就是持久归档，不依赖事件表回溯历史。
