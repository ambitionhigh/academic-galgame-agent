# 工作伙伴（WorkBuddy）技能安装脚本 — Windows PowerShell
#
# 把本目录下 skills/ 里的技能复制到 WorkBuddy 的技能目录：
#   %USERPROFILE%\.workbuddy\skills\<技能名>\
#
# 用法：
#   .\install.ps1                       # 安装到默认位置
#   .\install.ps1 -Target "D:\skills"   # 安装到自定义位置
param([string]$Target = '')

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dst = if ($Target) { $Target } else { Join-Path $HOME '.workbuddy\skills' }
$src = Join-Path $here 'skills'

if (-not (Test-Path $src)) { throw "未找到技能目录：$src" }

New-Item -ItemType Directory -Force -Path $dst | Out-Null

$installed = @()
foreach ($skill in Get-ChildItem $src -Directory) {
  $to = Join-Path $dst $skill.Name
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $skill.FullName $to -Recurse -Force
  Write-Host ("  ✓ " + $skill.Name + "  →  " + $to)
  $installed += $skill.Name
}

Write-Host ""
Write-Host ("已安装 " + $installed.Count + " 个技能到：" + $dst)
Write-Host ""
Write-Host "接下来："
Write-Host "  1. 打开 WorkBuddy，在对话里说：「开始教学，我想学纳什均衡」"
Write-Host "  2. 或用 @技能名 手动触发：@academic-galgame 看看我的进度"
Write-Host ""
Write-Host ("卸载：删除 " + $dst + " 下的 " + ($installed -join " / ") + " 目录即可。")
Write-Host ("存档位于：" + (Join-Path $HOME '.workbuddy\academic-galgame\save.json'))
