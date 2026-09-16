# Antigravity armor — 一键安装
# 用法: powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [-SkipTests] [-Model=deepseek-chat]
param([switch]$SkipTests, [string]$Model = 'deepseek-chat')
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Write-Host '== 1. 单测 ==' -ForegroundColor Cyan
if (-not $SkipTests) { node test/run.mjs; if ($LASTEXITCODE -ne 0) { Write-Host '单测失败，中止' -ForegroundColor Red; exit 1 } }

Write-Host '== 2. 预演（dry-run）==' -ForegroundColor Cyan
node src/cli.mjs install

Write-Host '== 3. 落盘 ==' -ForegroundColor Cyan
node src/cli.mjs install --apply

Write-Host '== 4. 启动改道代理 ==' -ForegroundColor Cyan
$listening = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 50100 } | Measure-Object).Count
if ($listening -gt 0) { Write-Host '  代理已在 50100 运行' }
else { Start-Process -FilePath 'node' -ArgumentList "`"$root\src\cli.mjs`" divert run --model=$Model" -WorkingDirectory $root -WindowStyle Hidden; Start-Sleep -Seconds 3 }

Write-Host '== 5. 状态 ==' -ForegroundColor Cyan
node src/cli.mjs status

Write-Host ''
Write-Host '完成。重启 Antigravity 后 L4/L5 生效。' -ForegroundColor Green
