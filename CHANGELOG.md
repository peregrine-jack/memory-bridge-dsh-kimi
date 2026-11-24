# Changelog

## v0.02 — 2026-11-24

首个公开发布。

- Kimi Work 插件元数据（`kimi.plugin.json` / `locales/` / `skills/dsh-memory/`），清单版本 0.0.2。
- `mcp/memory-keeper-mcp.mjs`（内部 v1.3.0）：stdio MCP server，7 个工具——`memory_search` / `memory_read` / `memory_propose` / `memory_write` / `memory_approve` / `memory_reject` / `memory_list_pending`。
- `bridge/sync-exchange.ps1`：导出记忆 BRIEF 到交换目录 outbox，并把 inbox 的外部提案摄入为待审批条目。
- `bridge/ack-kimi-notice.ps1`：标记 `TO-KIMI.md` 通知已处理。
- 所有个人绝对路径已替换为可移植写法：`DSH_HOME` / `DSH_EXCHANGE_DIR` 环境变量 + `USERPROFILE` 回退。

## 内部迭代史（2026-11-23 发布前，存档）

- **v1.1.0 → v1.3.0 分级直写改造**：新增 `memory_write`（Tier A 直写：白名单 + 敏感预检 + id 自动分配 + 写锁 + lint 失败 git 回滚 + 审计）；`memory_approve` / `memory_reject`（Tier B 提案任意基座审批，add 幂等，merge/archive 转人工）；`memory_search` 增加 `max_chars` 截断报告；读取侧 L0/L1/L2 分级注入；维护提醒从每月改为每周。
- **相似条目警告**：`memory_write` 与审批 add 时对新内容做 2-gram 包含度比对（≥0.5 提示、不拦截），机制参考社区 mcp-memory-server 分叉，不引入其 SQLite/embedding 依赖。
- **实战修复**：提案插入位置修复（新提案落进「已处理」区导致审批不可见）；审批 add 撞号时自动剥离内嵌 id 改分配新 id（替代整批 lint 回滚）。
- **质量验证**：57 项 fixture 测试全绿；16 步全功能验收（读类 / Tier A 直写 / 负例 / 审批闭环 / 工件核验）；DSH / Kimi Code / Kimi Work 三端真实接入。
