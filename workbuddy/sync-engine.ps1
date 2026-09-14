# sync-engine.ps1 —— 把主项目的引擎同步进 WorkBuddy 技能包
#
# 背景：WorkBuddy 技能必须自包含，所以 skills/academic-galgame/scripts/engine/ 是
#       从 src/engine/ 同步出来的副本。改了主项目引擎后务必跑一次本脚本，避免两边漂移。
#
# 用法：
#   .\sync-engine.ps1            # 同步（把源文件复制到技能包）
#   .\sync-engine.ps1 -Check     # 只校验：不一致则打印差异并以退出码 1 结束（适合 CI）
param([switch]$Check)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repoRoot = Split-Path $here -Parent
$src = Join-Path $repoRoot 'src\engine'
$dst = Join-Path $here 'skills\academic-galgame\scripts\engine'

# 技能内嵌引擎需要的最小集合（不含 storage.js / session.js —— 那是服务端用的）
$files = @('config.js', 'game.js', 'battle.js')

if (-not (Test-Path $src)) { throw "未找到源目录：$src" }
New-Item -ItemType Directory -Force -Path $dst | Out-Null

function Get-Hash([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  return (Get-FileHash $path -Algorithm SHA256).Hash
}

$same = @(); $diff = @(); $missing = @()

foreach ($f in $files) {
  $s = Join-Path $src $f
  $d = Join-Path $dst $f
  if (-not (Test-Path $s)) { throw "源文件缺失：$s" }
  $hs = Get-Hash $s
  $hd = Get-Hash $d
  if ($null -eq $hd) { $missing += $f }
  elseif ($hs -eq $hd) { $same += $f }
  else { $diff += $f }
}

Write-Host ""
Write-Host "  引擎同步检查"
Write-Host ("    源  : " + $src)
Write-Host ("    目标: " + $dst)
Write-Host ""

foreach ($f in $same)    { Write-Host ("    = " + $f + "  一致") }
foreach ($f in $diff)    { Write-Host ("    ~ " + $f + "  内容不同") }
foreach ($f in $missing) { Write-Host ("    + " + $f + "  目标缺失") }

$needSync = ($diff.Count + $missing.Count) -gt 0

if ($Check) {
  Write-Host ""
  if ($needSync) {
    Write-Host ("  ✗ 技能包引擎与主项目不一致（" + ($diff.Count + $missing.Count) + " 个文件）。请运行： .\sync-engine.ps1")
    exit 1
  }
  Write-Host "  ✓ 技能包引擎与主项目完全一致"
  exit 0
}

if (-not $needSync) {
  Write-Host ""
  Write-Host "  ✓ 已是最新，无需同步"
  exit 0
}

Write-Host ""
foreach ($f in ($diff + $missing)) {
  Copy-Item (Join-Path $src $f) (Join-Path $dst $f) -Force
  Write-Host ("    → 已同步 " + $f)
}

# 同步后再校验一次
$bad = 0
foreach ($f in $files) {
  if ((Get-Hash (Join-Path $src $f)) -ne (Get-Hash (Join-Path $dst $f))) { $bad++ }
}
Write-Host ""
if ($bad -gt 0) { Write-Host ("  ✗ 同步后仍不一致（" + $bad + " 个）"); exit 1 }
Write-Host "  ✓ 同步完成，已校验一致"
exit 0
