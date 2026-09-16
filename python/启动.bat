@echo off
title 学术galgame Agent - 鲸鱼娘老师
cd /d "%~dp0"

echo.
echo   ==========================================
echo     学术galgame Agent  Python 版
echo   ==========================================
echo.

rem ---- 找一个真正能用的 python（跳过 Windows 商店的假别名）----
set "PYEXE="
for /f "delims=" %%i in ('where python 2^>nul') do (
  echo %%i | find /i "WindowsApps" >nul
  if errorlevel 1 if not defined PYEXE set "PYEXE=%%i"
)
if not defined PYEXE (
  for /f "delims=" %%i in ('where py 2^>nul') do (
    echo %%i | find /i "WindowsApps" >nul
    if errorlevel 1 if not defined PYEXE set "PYEXE=%%i"
  )
)
if not defined PYEXE goto nopython

echo   使用：%PYEXE%
echo.
echo   正在启动，请稍候...
echo.
echo   浏览器会自动打开。没打开的话，手动访问：http://127.0.0.1:8787
echo   想停止：在这个窗口按 Ctrl + C，或者直接关掉本窗口。
echo.

set GALGAME_OPEN=1
"%PYEXE%" run.py

echo.
echo   服务已停止。按任意键关闭本窗口。
pause >nul
exit /b 0

:nopython
echo   [X] 没有找到可用的 Python。
echo.
echo       两种情况：
echo         1. 这台电脑没装 Python
echo         2. 装了，但安装时没勾选 "Add python.exe to PATH"
echo            （另外：如果你在 Microsoft Store 里看到过 Python，
echo              那是Windows的假别名，不算装好）
echo.
echo       请照这份文档做一次，几分钟就好：
echo         同目录下的「最简单的方法.md」
echo.
pause
exit /b 1
