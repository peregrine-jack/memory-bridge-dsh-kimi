# sync-exchange.ps1 — export BRIEF to outbox and ingest inbox proposals (PS 5.1, UTF-8 BOM)
param(
  [string]$Base = '',
  [string]$MemoryDir = ''
)
# Defaults: DSH_EXCHANGE_DIR env override, else %USERPROFILE%\dsh-memory-exchange
if (-not $Base) {
  $Base = if ($env:DSH_EXCHANGE_DIR) { $env:DSH_EXCHANGE_DIR } else { Join-Path $env:USERPROFILE 'dsh-memory-exchange' }
}
if (-not $MemoryDir) {
  $MemoryDir = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'memory' } else { Join-Path $env:USERPROFILE '.dsh\memory' }
}
$ErrorActionPreference = 'Stop'
$inbox = Join-Path $Base 'inbox'
$outbox = Join-Path $Base 'outbox'
$processed = Join-Path $Base '_processed'
$log = Join-Path $Base 'sync.log'
New-Item -ItemType Directory -Force -Path $inbox, $outbox, $processed | Out-Null
function Log($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}
$month = Get-Date -Format 'yyyy-MM'
$proposalFile = Join-Path $MemoryDir "_proposals\$month.md"

# ---------- 1. export BRIEF ----------
$indexFile = Join-Path $MemoryDir 'index.md'
$parts = @()
$parts += "# DSH 记忆 BRIEF（自动生成，只读）"
$parts += ''
$parts += "- generated_at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$parts += "- memory_dir: $MemoryDir"
$parts += "- 使用说明：本文件是 DSH 记忆摘要；详细内容请通过 MCP 工具 memory_read/memory_search 获取，或按路径直接读文件。"
$parts += ''
$parts += '## 索引摘要'
if (Test-Path $indexFile) {
  $lines = Get-Content $indexFile -Encoding UTF8 | Select-Object -First 45
  $parts += ($lines -join "`r`n")
} else { $parts += '(index.md 缺失)' }
$parts += ''
$parts += '## 项目状态摘要'
$projDir = Join-Path $MemoryDir 'projects'
if (Test-Path $projDir) {
  Get-ChildItem $projDir -Filter *.md | ForEach-Object {
    $head = Get-Content $_.FullName -Encoding UTF8 | Where-Object { $_ -match '^\- \[' } | Select-Object -First 2
    if ($head) { $parts += "### $($_.Name)"; $parts += ($head -join "`r`n"); $parts += '' }
  }
}
$parts += '## 待审批提案'
if (Test-Path $proposalFile) {
  $propLines = Get-Content $proposalFile -Encoding UTF8 | Where-Object { $_ -match '^\- \[P-' }
  $parts += "- 共 $($propLines.Count) 条（详见 ~/.dsh/memory/_proposals/$month.md）"
  $parts += ($propLines | Select-Object -First 10)
} else { $parts += '- 本月暂无提案' }
$parts += ''
$parts += '## 给 Kimi 的通知'
$toKimi = Join-Path $outbox 'TO-KIMI.md'
if (Test-Path $toKimi) {
  $notices = @(Get-Content $toKimi -Encoding UTF8 | Where-Object { $_ -match '^\- \[K-' -and $_ -notmatch 'handled:' })
  if ($notices.Count -gt 0) {
    $parts += "- 未处理 $($notices.Count) 条（详见 outbox/TO-KIMI.md）"
    $parts += ($notices | Select-Object -First 10)
  } else { $parts += '- 无未处理通知' }
} else { $parts += '- 无（TO-KIMI.md 未创建）' }
$parts += ''
$parts += '## 反向通道'
$parts += "- 外部 agent 提交提案：把 Markdown 写入 $inbox（格式见同目录 README.md）"
$parts += "- 只读/只提案；禁止直接写 DSH 记忆库；不要放凭据/手机号/逐字转写。"
$brief = $parts -join "`r`n"
$briefFile = Join-Path $outbox 'BRIEF.md'
$existing = if (Test-Path $briefFile) { Get-Content $briefFile -Raw -Encoding UTF8 } else { '' }
if ($brief -ne $existing) {
  [IO.File]::WriteAllText($briefFile, $brief, (New-Object Text.UTF8Encoding $false))
  Log "BRIEF written: $briefFile ($([Text.Encoding]::UTF8.GetByteCount($brief)) bytes)"
} else { Log 'BRIEF unchanged' }

# ---------- 2. ingest inbox ----------
function NextProposalId($file) {
  $max = 0
  if (Test-Path $file) {
    $text = Get-Content $file -Raw -Encoding UTF8
    foreach ($m in [regex]::Matches($text, '(?m)^\- \[P\-(\d+)\]')) { $n = [int]$m.Groups[1].Value; if ($n -gt $max) { $max = $n } }
  }
  return ('P-{0:d2}' -f ($max + 1))
}
$files = @(Get-ChildItem $inbox -File -ErrorAction SilentlyContinue)
$ingested = 0
foreach ($f in $files) {
  $text = Get-Content $f.FullName -Raw -Encoding UTF8
  if ($null -eq $text) { $text = '' }
  if ($text.Length -gt 100000) { $text = $text.Substring(0, 100000) + "`r`n[truncated]" }
  $id = NextProposalId $proposalFile
  $oneLine = ($text -replace "\r?\n", ' ').Trim()
  if ($oneLine.Length -gt 1500) { $oneLine = $oneLine.Substring(0, 1500) + '…' }
  if (-not (Test-Path $proposalFile)) {
    $header = "# 记忆提案 $month`r`n`r`n> 由 exchange / MCP 客户端提交；需 DSH 侧用户审批后写回。`r`n`r`n## 待审批`r`n"
    [IO.File]::WriteAllText($proposalFile, $header, (New-Object Text.UTF8Encoding $false))
  }
  $entry = "`r`n- [$id] external | file: $($f.Name) | received: $(Get-Date -Format 'yyyy-MM-dd HH:mm') | content: $oneLine | source: exchange/$($f.Name)`r`n"
  [IO.File]::AppendAllText($proposalFile, $entry, (New-Object Text.UTF8Encoding $false))
  $dst = Join-Path $processed ("{0}_{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $f.Name)
  Move-Item $f.FullName $dst -Force
  $ingested++
  Log "ingested $($f.Name) -> proposal $id"
}
Log "sync done: brief_updated, inbox_files=$($files.Count), ingested=$ingested, month=$month"
exit 0
