@echo off
title 学术galgame Agent - 鲸鱼娘老师
cd /d "%~dp0"

echo.
echo   ==========================================
echo     学术galgame Agent  Python 版
echo   ==========================================
echo.

where python >nul 2>nul
if errorlevel 1 goto nopython

echo   正在启动，请稍候...
echo.
echo   启动成功后，用浏览器打开：http://127.0.0.1:8787
echo   想停止：在这个窗口按 Ctrl + C，或者直接关掉本窗口。
echo.

python run.py

echo.
echo   服务已停止。按任意键关闭本窗口。
pause >nul
exit /b 0

:nopython
echo   [X] 没有找到 python。
echo.
echo       说明这台电脑还没装 Python，或者装的时候没有勾选
echo       "Add Python to PATH"。
echo.
echo       请先看同目录下的「新手部署教程.md」第 1 步。
echo.
pause
exit /b 1
