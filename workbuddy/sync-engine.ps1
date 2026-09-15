# sync-engine.ps1 —— 把主项目的引擎与立绘同步进 WorkBuddy 技能包
#
# 背景：WorkBuddy 技能必须自包含，所以技能里的 engine/ 与 assets/ 是从主项目同步出来的副本。
#       改了主项目后务必跑一次本脚本，避免两边漂移。
#
# 用法：
#   .\sync-engine.ps1            # 同步（只复制内容有变化的文件）
#   .\sync-engine.ps1 -Check     # 只校验：不一致则打印差异并以退出码 1 结束（适合 CI）
param([switch]$Check)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repoRoot = Split-Path $here -Parent
$skill = Join-Path $here 'skills\academic-galgame'

# 同步组：Files 为 $null 表示「源目录下的全部文件」
$groups = @(
  @{
    Name  = '引擎'
    Src   = Join-Path $repoRoot 'src\engine'
    Dst   = Join-Path $skill 'scripts\engine'
    Files = @('config.js', 'game.js', 'battle.js')   # storage.js / session.js 是服务端专用，不进技能包
  },
  @{
    Name  = '立绘'
    Src   = Join-Path $repoRoot 'src\web\assets\whale-girl'
    Dst   = Join-Path $skill 'assets\whale-girl'
    Files = $null
  }
)

function Get-Hash([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  return (Get-FileHash $path -Algorithm SHA256).Hash
}

function Get-GroupFiles($g) {
  if ($null -eq $g.Files) { return @(Get-ChildItem $g.Src -File | ForEach-Object { $_.Name }) }
  return $g.Files
}

$totalDiff = 0
$totalMissing = 0
$plan = @()

Write-Host ""
Write-Host "  技能包同步检查"
Write-Host ("    主项目: " + $repoRoot)
Write-Host ("    技能包: " + $skill)
Write-Host ""

foreach ($g in $groups) {
  if (-not (Test-Path $g.Src)) { throw ("未找到源目录（" + $g.Name + "）：" + $g.Src) }
  $files = Get-GroupFiles $g

  $same = 0; $diff = @(); $missing = @()
  foreach ($f in $files) {
    $hs = Get-Hash (Join-Path $g.Src $f)
    $hd = Get-Hash (Join-Path $g.Dst $f)
    if ($null -eq $hs) { continue }
    if ($null -eq $hd) { $missing += $f }
    elseif ($hs -eq $hd) { $same++ }
    else { $diff += $f }
  }

  $totalDiff += $diff.Count
  $totalMissing += $missing.Count
  $plan += @{ Group = $g; Diff = $diff; Missing = $missing }

  $status = if (($diff.Count + $missing.Count) -eq 0) { "✓ 一致" } else { ("需同步 " + ($diff.Count + $missing.Count) + " 个") }
  Write-Host ("    [" + $g.Name + "] 共 " + $files.Count + " 个，一致 " + $same + "  → " + $status)
  foreach ($f in $diff)    { Write-Host ("        ~ " + $f + "  内容不同") }
  foreach ($f in $missing) { Write-Host ("        + " + $f + "  目标缺失") }
}

$needSync = ($totalDiff + $totalMissing) -gt 0
Write-Host ""

if ($Check) {
  if ($needSync) {
    Write-Host ("  ✗ 技能包与主项目不一致（" + ($totalDiff + $totalMissing) + " 个文件）。请运行： .\sync-engine.ps1")
    exit 1
  }
  Write-Host "  ✓ 技能包与主项目完全一致"
  exit 0
}

if (-not $needSync) {
  Write-Host "  ✓ 已是最新，无需同步"
  exit 0
}

foreach ($p in $plan) {
  $g = $p.Group
  $toCopy = @($p.Diff) + @($p.Missing)
  if ($toCopy.Count -eq 0) { continue }
  New-Item -ItemType Directory -Force -Path $g.Dst | Out-Null
  foreach ($f in $toCopy) {
    Copy-Item (Join-Path $g.Src $f) (Join-Path $g.Dst $f) -Force
    Write-Host ("    → 已同步 [" + $g.Name + "] " + $f)
  }
}

# 同步后复验
$bad = 0
foreach ($g in $groups) {
  foreach ($f in (Get-GroupFiles $g)) {
    if ((Get-Hash (Join-Path $g.Src $f)) -ne (Get-Hash (Join-Path $g.Dst $f))) { $bad++ }
  }
}
Write-Host ""
if ($bad -gt 0) { Write-Host ("  ✗ 同步后仍不一致（" + $bad + " 个）"); exit 1 }
Write-Host "  ✓ 同步完成，已校验一致"
exit 0
