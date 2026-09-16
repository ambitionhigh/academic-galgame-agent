# 学术galgame · 一键打包（Windows 桌面发行包）
#
# 做四件事：
#   1. 下载打包工具（PyInstaller）的 wheel —— 用 Node 下载，绕开本机 pip 的联网问题
#   2. 解包 wheel 到 .pylibs（不经过 pip，pip 在本机受限）
#   3. 用 PyInstaller 把 Python 版打成一个双击即用的 exe
#   4. 组装发行目录 + 压缩包
#
# 用法（在 desktop 目录下）：
#   .\build\build.ps1               # 完整打包
#   .\build\build.ps1 -SkipDeps     # 跳过前两步（已装过 PyInstaller 时更快）
#   .\build\build.ps1 -NoZip        # 只组装目录，不压缩

[CmdletBinding()]
param(
    [switch]$SkipDeps,
    [switch]$NoZip,
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$BuildDir = Split-Path -Parent $PSCommandPath
$Desktop  = Split-Path -Parent $BuildDir
$Repo     = Split-Path -Parent $Desktop
$PySrc   = Join-Path $Repo "python"
$Wheels  = Join-Path $Desktop ".wheels"
$PyLibs  = Join-Path $Desktop ".pylibs"
$Dist    = Join-Path $Desktop "dist"
$Work    = Join-Path $Desktop "build\work"
$Ico     = Join-Path $Desktop "app.ico"
$Launcher= Join-Path $Desktop "launcher.pyw"
$AppName = "学术galgame"
$BuildName = "AcademicGalgame"          # PyInstaller 不吃中文名，先英文再改回来

function Step($n, $t) { Write-Host ""; Write-Host "── $n  $t" -ForegroundColor Cyan }
function Ok($t)      { Write-Host "   ✓ $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "   ! $t" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  学术galgame · Windows 桌面发行包" -ForegroundColor White

# ── 0. 前置检查 ────────────────────────────────────────────────
Step "0/5" "检查环境"
if (-not (Test-Path (Join-Path $PySrc "server\server.py"))) { throw "找不到 Python 版源码：$PySrc" }
if (-not (Test-Path $Launcher)) { throw "找不到启动器：$Launcher" }
if (-not (Test-Path $Ico)) {
    Warn "app.ico 不存在，从立绘重新生成"
    Push-Location $Desktop; node make-icon.js --out app.ico; Pop-Location
}
Ok "源码 $PySrc"
Ok "启动器 $Launcher"
Ok "图标   $Ico"

# ── 1-2. 打包工具 ──────────────────────────────────────────────
if (-not $SkipDeps) {
    Step "1/5" "下载打包工具（PyInstaller wheel）"
    Push-Location $Desktop
    node build\fetch-wheels.js --out $Wheels
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "wheel 下载失败" }
    Pop-Location
    Ok "wheel 就绪"

    Step "2/5" "解包 wheel"
    Push-Location $Desktop
    node build\install-wheels.js --wheels $Wheels --out $PyLibs
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "wheel 解包失败" }
    Pop-Location
    Ok "PyInstaller 就绪"
} else {
    Step "1-2/5" "跳过打包工具准备"
}

$env:PYTHONPATH = $PyLibs
python -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 不可用，去掉 -SkipDeps 重跑一次" }

# ── 3. 打包 exe ────────────────────────────────────────────────
Step "3/5" "打包 exe（PyInstaller）"
$spec = Join-Path $Desktop "build\$BuildName.spec"
$pyiArgs = @(
    "--noconfirm", "--clean", "--onedir", "--noconsole",
    "--name", $BuildName,
    "--icon", $Ico,
    "--paths", $PySrc,
    "--hidden-import", "server.server",
    "--collect-submodules", "agent",
    "--collect-submodules", "engine",
    "--collect-submodules", "server",
    "--add-data", "$(Join-Path $PySrc 'web');web",
    "--add-data", "$(Join-Path $PySrc 'corpus');corpus",
    "--add-data", "$(Join-Path $PySrc 'agent\persona.md');agent",
    "--add-data", "$Ico;.",
    "--distpath", $Dist,
    "--workpath", $Work,
    "--specpath", (Join-Path $Desktop "build"),
    $Launcher
)
$logFile = Join-Path $Desktop "build\pyinstaller.log"
# 注意：native 命令的 stderr 在 $ErrorActionPreference='Stop' 下会被当成终止错误，
# 所以这里临时放宽，并把全部输出重定向到日志文件再解析。
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& python -m PyInstaller @pyiArgs *> $logFile
$pyiCode = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($pyiCode -ne 0) {
    Get-Content $logFile -Tail 25 | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkGray }
    throw "PyInstaller 打包失败（完整日志：$logFile）"
}
Select-String -Path $logFile -Pattern "COLLECT-00.toc completed|WARNING: lib not found" |
    ForEach-Object { Write-Host "   $($_.Line)" }
Ok "exe 打包完成"
# ── 4. 组装发行目录 ────────────────────────────────────────────
Step "4/5" "组装发行目录"
$Built = Join-Path $Dist $BuildName
$Rel   = if ($OutDir) { $OutDir } else { Join-Path $Desktop "release\$AppName" }
if (Test-Path $Rel) { Remove-Item $Rel -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Rel | Out-Null

# exe 改名回中文
$builtExe = Join-Path $Built "$BuildName.exe"
$finalExe = Join-Path $Rel "$AppName.exe"
Move-Item $builtExe $finalExe
Move-Item (Join-Path $Built "_internal") (Join-Path $Rel "_internal")
Remove-Item $Built -Recurse -Force -ErrorAction SilentlyContinue

# 图标放到 exe 旁边（桌面快捷方式指向这里）
Copy-Item $Ico (Join-Path $Rel "鲸鱼娘.ico")
Copy-Item (Join-Path $Desktop "release-files\使用说明.txt") (Join-Path $Rel "使用说明.txt")
Ok "exe + 运行时 + 图标 + 说明"

# .bat 有三个必须同时满足的坑：
#   ① 编码必须是 GBK —— cmd.exe 在中文 Windows 上按 ANSI 读批处理，存 UTF-8 会乱码
#   ② 换行必须是 CRLF —— 只有 LF 时 cmd 会把每行拆错，报一堆 "'/d' is not recognized"
#   ③ 开头要 chcp 936 —— cmd 是「边读边用当前代码页解码」的；系统默认代码页不是 936 时，
#      连 "学术galgame.exe" 这个文件名都会解析不出来。切一次就稳了。
function Write-Bat($name, $text) {
    $path = Join-Path $Rel $name
    $text = ($text -replace "`r`n", "`n") -replace "`n", "`r`n"
    $text = $text -replace "^@echo off\r\n", "@echo off`r`nchcp 936 >nul`r`n"
    [System.IO.File]::WriteAllText($path, $text, [System.Text.Encoding]::GetEncoding(936))
}

Write-Bat "停止.bat" @"
@echo off
cd /d "%~dp0"
echo.
echo   正在停止学术galgame...
echo.
"$AppName.exe" --stop
echo.
pause
"@

Write-Bat "自检.bat" @"
@echo off
cd /d "%~dp0"
title 学术galgame - 自检
echo.
"$AppName.exe" --selftest
echo.
pause
"@

Write-Bat "排查模式.bat" @"
@echo off
cd /d "%~dp0"
title 学术galgame - 排查模式（这个窗口不要关）
echo.
echo   正在以排查模式启动，运行日志就显示在这个窗口里。
echo   关掉这个窗口 = 结束游戏。
echo.
"$AppName.exe" --console
echo.
echo   已退出。把上面的内容复制出来即可定位问题。
pause
"@

Write-Bat "重新创建桌面快捷方式.bat" @"
@echo off
cd /d "%~dp0"
echo.
"$AppName.exe" --shortcut
echo.
pause
"@

Ok "停止.bat / 自检.bat / 排查模式.bat / 重新创建桌面快捷方式.bat"

$size = (Get-ChildItem -Recurse $Rel | Measure-Object Length -Sum).Sum / 1MB
Ok ("发行目录大小 {0:N1} MB" -f $size)

# ── 5. 压缩 ────────────────────────────────────────────────────
if (-not $NoZip) {
    Step "5/5" "压缩"
    # 压缩包用纯 ASCII 名：下载链接里不会出现百分号编码，任何浏览器/工具都不会出错
    # （解压出来的文件夹仍然是中文的「学术galgame」）
    $zip = Join-Path $Desktop "release\academic-galgame-windows.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    # jar 走 UTF-8 存文件名，避免解压后中文乱码；Compress-Archive 在这点上不可靠
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) {
        Push-Location (Split-Path -Parent $Rel)
        & tar.exe -a -c -f $zip $AppName
        Pop-Location
        if ($LASTEXITCODE -ne 0) { throw "tar 压缩失败" }
    } else {
        Compress-Archive -Path $Rel -DestinationPath $zip -Force
        Warn "用 Compress-Archive 打包，中文文件名在部分解压工具里可能乱码"
    }
    Ok ("压缩包 {0}（{1:N1} MB）" -f $zip, ((Get-Item $zip).Length / 1MB))
    Write-Host ""
    Write-Host "  完成：$zip" -ForegroundColor Green
} else {
    Step "5/5" "跳过压缩"
    Write-Host ""
    Write-Host "  完成：$Rel" -ForegroundColor Green
}
Write-Host ""
