# ack-kimi-notice.ps1 — 标记 TO-KIMI.md 中某条通知已处理（PS 5.1，UTF-8 BOM）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ack-kimi-notice.ps1 -Id K-01 [-By kimi-code] [-Note "摘要"]
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [string]$By = 'kimi-code',
  [string]$Note = '',
  [string]$Base = '',
  [string]$File = ''
)
if (-not $File) {
  if (-not $Base) {
    $Base = if ($env:DSH_EXCHANGE_DIR) { $env:DSH_EXCHANGE_DIR } else { Join-Path $env:USERPROFILE 'dsh-memory-exchange' }
  }
  $File = Join-Path $Base 'outbox\TO-KIMI.md'
}
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $File)) { throw "not found: $File" }
$text = Get-Content $File -Raw -Encoding UTF8
$pattern = '(?m)^- \[' + [regex]::Escape($Id) + '\][^\r\n]*'
$m = [regex]::Match($text, $pattern)
if (-not $m.Success) { throw "notice $Id not found" }
$line = $m.Value
if ($line -match 'handled:') { Write-Host "already handled: $line"; exit 0 }
$stamp = Get-Date -Format 'yyyy-MM-dd'
$addition = " | handled: $stamp by $By"
if ($Note) { $addition += " | note: $($Note -replace '[\r\n]+', ' ')" }
$newLine = $line + $addition
$text = $text.Substring(0, $m.Index) + $newLine + $text.Substring($m.Index + $m.Length)
[IO.File]::WriteAllText($File, $text, (New-Object Text.UTF8Encoding $false))
Write-Host "acked $Id"
