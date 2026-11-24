# dsh-memory — Kimi Work 插件（DSH 本地长期记忆）

让 Kimi Work 复用与 Kimi Code 相同的 DSH 本地记忆服务（`memory-keeper-mcp.mjs`，stdio MCP，单文件零依赖）。

- 记忆库真相源：`~/.dsh/memory\`（Markdown，由 DSH 维护）。
- 本插件分级写入：Tier A（`facts.md`/`projects/*.md` 新增、`journal/` 追加）经 `memory_write` 直写，带敏感拦截 + lint 回滚 + 审计；Tier B（修改/删除/合并/归档及敏感区文件）走 `memory_propose` 提案，`memory_approve` 审批后落盘。
- 数据只在本机，不联网。

## 一、安装

1. 本插件即本仓库目录，内含 `kimi.plugin.json` 与 `skills\`。
2. 在 Kimi Work 中打开**插件中心 / 个人插件**，选择「导入本地插件」（或「从本地目录安装」），选中本目录（包含 `kimi.plugin.json` 的那一层）。
   - 如果 Kimi Work 的版本只支持把整个插件目录拷贝到其个人插件目录（如 `~/.kimi-work/plugins`，以你的 Kimi Work 版本为准），把本目录**整体复制**过去即可，然后在插件列表中启用。
   - 具体入口名称以你安装的 Kimi Work 版本为准；两者本质都是让宿主读到 `kimi.plugin.json`。
3. 启用后，宿主会自动拉起 stdio MCP server（Node 单文件），工具以 `mcp__dsh-memory__*` 命名空间出现。

> 注意：MCP server 路径在 `kimi.plugin.json` 中配置（见仓库根 README 的安装步骤），与 Kimi Code 的 `mcp.json` 指向同一个脚本时，两处共用同一份记忆库，无需双份维护。

## 二、建议的权限配置

按「读自由、写受控、审批严」的原则：

- **allow（自动放行）**：只读类
  - `mcp__dsh-memory__memory_search`
  - `mcp__dsh-memory__memory_read`
  - `mcp__dsh-memory__memory_list_pending`
- **ask（每次询问）**：写入与审批类
  - `mcp__dsh-memory__memory_propose`（提交提案——本身不落盘，但建议确认后提交）
  - `mcp__dsh-memory__memory_approve` / `mcp__dsh-memory__memory_reject`（审批——通常只在用户明确说批准时才会走到）

在 Kimi Code / Kimi Work 的 `config.toml` 中，对应 `[[permission.rules]]` 示例（通配按 `mcp__dsh-memory__*` 前缀匹配）：

```toml
[[permission.rules]]
pattern = "mcp__dsh-memory__memory_*"
action = "allow"

[[permission.rules]]
pattern = "mcp__dsh-memory__memory_write"
action = "ask"

[[permission.rules]]
pattern = "mcp__dsh-memory__memory_approve"
action = "ask"

[[permission.rules]]
pattern = "mcp__dsh-memory__memory_reject"
action = "ask"

[[permission.rules]]
pattern = "mcp__dsh-memory__memory_propose"
action = "ask"
```

（若宿主的规则按顺序取第一条命中，请把 `memory_*` 的 allow 规则放在最后，或改成逐条列出三个读工具。具体字段名以宿主当前版本文档为准。）

## 三、使用说明

### 新工具一览（命名空间 `mcp__dsh-memory__`）

| 工具 | 作用 | 建议权限 |
|---|---|---|
| `memory_search` | 检索记忆库（memory / sessions / archive / kb / obsidian） | allow |
| `memory_read` | 读单个记忆文件（如 `index.md`、`profile.md`） | allow |
| `memory_list_pending` | 列出本月待审批提案 | allow |
| `memory_propose` | 提交新记忆/变更提案（仅追加到 `_proposals/`，不落盘） | ask |
| `memory_write` | Tier A 直写（限 facts/projects 新增、journal 追加；敏感拦截 + lint 回滚 + 审计） | ask |
| `memory_approve` | 批准提案，落盘生效 | ask |
| `memory_reject` | 拒绝提案 | ask |

### approve 纪律（重要）

- **只在用户当前会话中明确说出「批准 / 同意 / approve」之类的话时才调用 `memory_approve` / `memory_reject`。** 不接受「以前说过」「按惯例」这类推断。
- 写入分两级：新增事实（facts/projects/journal）用 `memory_write` 直写；修改/删除既有条目用 `memory_propose` 提案，等用户审批。用户没让写时不要主动写。
- 拒绝提案用 `memory_reject`，不用沉默代替。

### 更多上下文

`skills\SKILL.md` 是从 Kimi Code 侧 `dsh-memory` 技能复制的使用说明（何时用/不用、会话开场顺序、DSH 出口文件 BRIEF.md / TO-KIMI.md 的处理流程），建议 agent 首次使用时阅读。

## 四、不确定项备注

- **`$schema`**：官方三个插件各用了不同 schema URL（`kimi.com`、`statics.kimi.ai/catalog` 等），此处取 webbridge 所用的 `https://kimi.com/schemas/kimi.plugin.schema.json`；若导入时报 schema 校验警告，以 Kimi Work 导入器提示为准，可删除或替换该字段。
- **`skills` 字段**：kimi-webbridge / kimi-cu-win 用 `"skills": "./skills/"` 指向目录；kimi-datasource 未用。本插件按前者声明。若导入后技能未加载，可先删除该字段，MCP 工具不受影响。
- **插件安装入口**：不同 Kimi Work 版本的「导入本地插件」入口名称/目录位置可能不同，见第一节说明。
