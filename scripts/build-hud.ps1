# build-hud —— 构建悬浮窗（WPF，framework-dependent，离线可跑）
#
# 产物：dist/hud/ArmorHud.exe（约 200 KB）+ 依赖清单；不打包运行时，
# 用本机已装的 Microsoft.WindowsDesktop.App 8.0.x。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $root 'hud'
$out  = Join-Path $root 'dist\hud'

Write-Host "[build-hud] dotnet publish $proj -> $out"
dotnet publish $proj -c Release -r win-x64 --self-contained false -o $out /nologo /v:m
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败 (exit $LASTEXITCODE)" }

$exe = Join-Path $out 'ArmorHud.exe'
if (-not (Test-Path $exe)) { throw "产物缺失: $exe" }
$size = [math]::Round((Get-Item $exe).Length / 1KB, 1)
Write-Host "[build-hud] ok  $exe  (${size} KB)"
