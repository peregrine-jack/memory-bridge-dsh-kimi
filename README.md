# dsh-memory

让 **Kimi Work** 与 **Kimi Code** 共享同一份 DSH 本地长期记忆（Markdown 记忆库）的桥接插件。带分级写入、提案审批与双向文件同步，数据只在本机，不联网。

当前版本：**v0.02**（首个公开发布，见 [CHANGELOG](CHANGELOG.md)）

## 设计由来

这个插件不是凭空设计的，是从一次真实的维护危机里长出来的（2026-11-23 的完整讨论）：

- **起点**：Kimi Code / Kimi Work 没有跨会话的事实记忆——官方机制只覆盖单会话恢复和 AGENTS.md 手工维护。而 DSH 在本机维护一份 git 化的 Markdown 记忆库（`~/.dsh/memory/`）。本插件把后者接给前者。
- **为什么不做全自动写**：记忆库是真相源，错误会自我强化——agent 读到错条目 → 基于它推理 → 再写入更多错误。当天就抓到实证：两条待批提案的 `as_of` 日期抄错了两天，人工审批一眼能发现，自动写就悄悄进库了。所以保留人工审批闸，只把低风险写入自动化。
- **分级方案**（本次发布的核心）：Tier A（`memory_write`：facts/projects 新增条目、journal 追加）自动直写，带敏感预检 + lint 失败 git 回滚 + 审计日志；Tier B（修改/删除/合并/归档）仍走提案审批，但审批可在**任意基座**完成，维护节奏从每月改为每周。
- **只抄机制、不引依赖**：调研社区主流记忆插件（mem0 / Letta / Graphiti 等）后，吸收了一个成熟分叉（mcp-memory-server）验证过的设计——相似条目 2-gram 警告（≥0.5 提示不拦截），但没有引入它的 SQLite / embedding 依赖。
- **经过实战检验**：57 项 fixture 测试 + 16 步全功能验收（含负例拦截、幂等、回滚）+ DSH / Kimi Code / Kimi Work 三端真实接入；过程中修掉两个实战 bug（提案落位、id 撞号自动改分配）。

**运维常识**：修改 `mcp/memory-keeper-mcp.mjs` 后，已打开的客户端窗口要重开才会加载新代码（stdio server 不会热重载）。

## 它是什么

DSH（DeepSeek Harness）在本机维护一份 Markdown 长期记忆库（`~/.dsh/memory/`）。本仓库让 Kimi 系的 agent（Kimi Work 插件、Kimi Code 的 MCP 配置）直接读写这份记忆：

- **分级检索**：`memory_search` / `memory_read` / `memory_list_pending`，只读，可自动放行。
- **Tier A 直写**：`memory_write` 仅限 facts/projects 新增条目与 journal 追加；写入前过敏感拦截（API key / 手机号 / wxid / Bearer token），写后 lint 失败自动 git 回滚，全程记审计日志。
- **Tier B 提案审批**：`memory_propose` 只追加提案不落盘；`memory_approve` / `memory_reject` 可在任意 MCP 客户端完成审批，且只响应用户当会话的明确指令。
- **双向同步**：`bridge/sync-exchange.ps1` 把记忆摘要导出成 `BRIEF.md` 供任何 agent 开箱读取，并把外部写入 inbox 的 Markdown 提案摄入为待审批条目；`bridge/ack-kimi-notice.ps1` 负责通知回执闭环。
- **零依赖**：MCP server 是单个 Node 文件，无第三方包。

## 仓库结构

```
dsh-memory/
├── kimi.plugin.json          # Kimi Work 插件清单（导入本目录即可）
├── locales/en-US.json
├── skills/dsh-memory/SKILL.md   # agent 使用说明（何时用、纪律、数据位置）
├── mcp/
│   └── memory-keeper-mcp.mjs    # stdio MCP server（7 个工具，单文件）
├── bridge/
│   ├── sync-exchange.ps1        # 导出 BRIEF + 摄入 inbox 提案
│   └── ack-kimi-notice.ps1      # 标记 TO-KIMI.md 通知已处理
├── docs/usage.md                # 插件安装、权限配置与工具一览
├── CHANGELOG.md
└── LICENSE
```

## 依赖

- Windows + PowerShell 5.1（同步脚本）；Node.js（MCP server，任一现代版本，需在 PATH 中）
- 已初始化并 git 化的 DSH 记忆库 `~/.dsh/memory/`（`index.md` 为索引）
- DSH 的 memory-keeper 检索 / lint 脚本（`~/.dsh/skills/memory-keeper/scripts/`）——随 DSH 提供，不属于本仓库

## 安装

1. 克隆到任意位置（建议 `~/.dsh/kimi-bridge`）：

   ```powershell
   git clone https://github.com/peregrine-jack/dsh-memory.git "$env:USERPROFILE\.dsh\kimi-bridge"
   ```

2. 编辑 `kimi.plugin.json`，把 `mcpServers.dsh-memory.args[0]` 中的 `CHANGE_ME:\path\to\...` 改成 `mcp/memory-keeper-mcp.mjs` 的实际绝对路径；若 `node` 不在 PATH，把 `command` 改成 node 的绝对路径。
3. 在 Kimi Work 打开「插件中心 / 个人插件」→「导入本地插件」，选中本目录（包含 `kimi.plugin.json` 的这一层），启用后工具以 `mcp__dsh-memory__*` 命名空间出现。
4. 按 [docs/usage.md](docs/usage.md) 配置工具权限（读 allow / 写 ask）。

### 环境变量（可选）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 主目录（记忆库在其下 `memory/`） |
| `DSH_EXCHANGE_DIR` | `~/dsh-memory-exchange` | 双向同步交换目录（`inbox` / `outbox`） |

## 隐私与安全

- 全部数据留在本机，MCP server 不发起任何网络请求。
- 写入前的敏感预检会拒绝 API key、手机号、wxid、Bearer token，命中即拒写。
- 记忆库已 git 化，lint 失败自动回滚，所有写入记审计日志。
- 审批（approve/reject）只响应用户当前会话的明确指令，agent 不会自行审批。

## 许可证

[MIT](LICENSE)
