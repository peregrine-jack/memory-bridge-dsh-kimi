# Changelog

## v0.02 — 2026-11-24

首个公开发布。

- Kimi Work 插件元数据（`kimi.plugin.json` / `locales/` / `skills/dsh-memory/`），清单版本 0.0.2。
- `mcp/memory-keeper-mcp.mjs`（内部 v1.3.0）：stdio MCP server，7 个工具——`memory_search` / `memory_read` / `memory_propose` / `memory_write` / `memory_approve` / `memory_reject` / `memory_list_pending`。
- `bridge/sync-exchange.ps1`：导出记忆 BRIEF 到交换目录 outbox，并把 inbox 的外部提案摄入为待审批条目。
- `bridge/ack-kimi-notice.ps1`：标记 `TO-KIMI.md` 通知已处理。
- 所有个人绝对路径已替换为可移植写法：`DSH_HOME` / `DSH_EXCHANGE_DIR` 环境变量 + `USERPROFILE` 回退。
