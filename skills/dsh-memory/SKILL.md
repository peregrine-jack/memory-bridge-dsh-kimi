---
name: dsh-memory
description: DSH 本地长期记忆（分级写入：Tier A 经 memory_write 直写 / Tier B 提案审批；审批可在任意基座用 memory_approve/memory_reject 完成）。当用户问「以前/上次/之前/在哪儿/哪个文件」，或需要跨会话接续项目状态、查旧会话/笔记/知识库/学习库时使用；也可向 DSH 记忆写入新事实或提交提案（审批均需用户明确指令）。数据在本机，不联网。
---

# dsh-memory（DSH 本地记忆桥）

真相源：`~/.dsh/memory\`（Markdown，DSH 维护，已 git 化）。本技能在 Kimi Code / Kimi Work 侧提供**分级写入 + 检索**：Tier A 可经 `memory_write` 直写，Tier B 走提案审批。

## 何时用 / 不用

**用**：用户问过去的事（「以前」「上次」「之前」「在哪儿」「哪个文件」「我记得」）；需要项目接续（「v3 管线到哪了」「作业四状态」「国安比赛结果」）；要查旧会话/笔记/知识库/学习库；想在 DSH 记忆里记一条新事实（走提案）。
**不用**：实时/外部知识（用 web_search）；已知具体文件要看全文（直接读文件）；改 DSH 记忆正文——分级：Tier A（projects/*.md 新增、facts.md 新增、journal 追加）用 `memory_write`，其余一律 `memory_propose` 提案，绝不绕开这两个通道。

## 会话开场：先读 DSH 的出口（双向）

新会话涉及用户本人/项目/历史时，按顺序做一次，读完再干活：

1. `memory_read index.md`（有 MCP 时）定位记忆库。
2. 读 `~/dsh-memory-exchange\outbox\BRIEF.md`：DSH 的索引摘要、项目状态、待审批提案、**给 Kimi 的通知**（Kimi Code 已配 `SessionStart` hook 自动刷新；其他客户端先跑 `~/.dsh/kimi-bridge/sync-exchange.ps1`）。
3. 读 `~/dsh-memory-exchange\outbox\TO-KIMI.md`（若存在）：只看**不含 `handled:`** 的 `- [K-xx]` 行，这些是 DSH 要求 Kimi 处理的事项。
4. 处理完一条通知，**不要删行**，追加回执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "~/.dsh/kimi-bridge\ack-kimi-notice.ps1" -Id K-01 -Note "已处理：<一句话>"
```

回执后才算闭环；没回执的条目会一直出现在 BRIEF 里。

## MCP 工具（若当前会话有 `mcp__dsh-memory__*` 或 `dsh-memory` 命名空间）

- `memory_search {query, sources?, limit?}`：查记忆；`sources` 可选 `memory`（默认）/`sessions`/`archive`/`kb`/`obsidian`；返回 JSON（hits/path/snippet/date）。
- `memory_read {path}`：读记忆文件，如 `index.md`、`profile.md`、`projects/obsidian-v3.md`。
- `memory_propose {type, target, targetId?, content?, reason, source, confidence?}`：提交提案（add/update/merge/archive/**delete**/question），**不会直接改记忆**，等 DSH 侧用户审批。
  - 删除走 `type: "delete"` + `targetId`（如 `f-029`），服务端会校验该 id 在目标文件里真实存在，并把「原 id + 现内容」写进提案；**仍要 DSH 侧批准才真正删除**。
- `memory_list_pending {}`：看当月待审批提案。
- `memory_write {target, content, source}`：**Tier A 直写**——仅限 `projects/*.md` 新增条目、`facts.md` 新增条目、`journal/` 追加。服务端强制敏感词拦截、写后 lint 失败自动 git 回滚、全程记 `_proposals/auto-log-YYYY-MM.md` 审计。Tier B 写入**不要**用这个工具。
- `memory_approve {id?}` / `memory_reject {id?, reason?}`：在**任意 MCP 客户端**审批/拒绝待批提案（替代只能在 DSH 侧审批的旧流程）。**调用纪律：agent 只在用户当会话明确说「批准/拒绝」时才调用**，不得自行审批；审批动作同样记入 auto-log。

推荐用法：先 `memory_read index.md` 定位，再按需读文件/搜索；引用时给「文件路径 + 条目 id + as_of + 片段」；不确定时 `memory_search` 搜全源。

## 无 MCP 时的文件交换协议（Kimi Work 兜底 / 其他 agent 通用）

- 读：`~/dsh-memory-exchange\outbox\BRIEF.md`（DSH 导出的记忆摘要，尽量开场读一次）。
- 写：把提案写成 Markdown 文件放到 `~/dsh-memory-exchange\inbox\`，文件名 `<日期>-<主题>.md`，格式：

```markdown
# 提案：<一句话>
- 类型：add | update | merge | archive | delete | question
- 目标：profile.md | facts.md | rules.md | projects/xxx.md | questions.md
- 原 id：<delete 必填，如 f-029；update/archive 建议填>
- 内容：<一行事实/建议；delete 可省略>
- 理由：<为什么值得记>
- 来源：<文件/会话/URL>
- 日期：YYYY-MM-DD
- 置信度：high | medium | low
```

DSH 侧会定期摄入到 `_proposals/`，经用户审批后才写回。

## 纪律（硬性）

1. **分级写入，两通道**：Tier A（`projects/*.md` 新增、`facts.md` 新增条目、`journal/` 追加）用 `memory_write` 直写；Tier B（update/merge/archive/delete，及对 profile.md / rules.md / history/ / index.md / questions.md 的写入）用 `memory_propose` 提案。绝不绕开这两个通道直接修改 `~/.dsh/memory\` 下任何文件；绝不修改 DSH 的 AGENTS.md。
2. 每提案必须带 source 与日期；推断内容标 `inferred`；冲突内容标 `question` 并说明两种口径。
3. **数据边界**：不把 API key/密码/手机号/身份证/精确住址/银行卡写入或带出；不索引/搬运逐字转写原文（含时政段落，会触发内容风控死锁）；只给安全摘要与路径指针。
4. 引用记忆时标注「来源 + as_of」，旧机历史条目（`machine: old`）不得当现状。
5. 搜不到就明说「没有检索到」，不要编造。

## 数据位置速查

- 记忆库：`~/.dsh/memory\`（`index.md` 先读）
- 检索脚本（无 MCP 时可直接跑）：`~/.dsh/skills\memory-keeper\scripts\memory-search.mjs`
- 交换目录：`~/dsh-memory-exchange\`
