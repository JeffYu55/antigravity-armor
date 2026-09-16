# Antigravity armor — 卸载/还原
param([switch]$KeepRules)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Write-Host '== 停代理 ==' -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*armor*divert*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process -Name language_server -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host '== 还原 IDE endpoint ==' -ForegroundColor Cyan
node src/cli.mjs rollback --layer=ide

Write-Host '== 还原二进制 ==' -ForegroundColor Cyan
node src/cli.mjs rollback --layer=binary

if (-not $KeepRules) {
  Write-Host '== 移除规则/技能 ==' -ForegroundColor Cyan
  node src/cli.mjs rollback --layer=rules    # 列出备份（原文件不会被自动删除）
  Write-Host '  提示：AGENTS.md / SKILL.md 需按上面的备份清单手工还原' -ForegroundColor Yellow
}

Write-Host '== 移除钩子 ==' -ForegroundColor Cyan
node src/cli.mjs rollback --layer=hooks

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
