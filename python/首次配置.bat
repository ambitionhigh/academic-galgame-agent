@echo off
title 学术galgame Agent - 首次配置
cd /d "%~dp0"

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
if not defined PYEXE (
  echo.
  echo   [X] 没有找到可用的 Python。
  echo       请先看「最简单的方法.md」。
  echo.
  pause
  exit /b 1
)

"%PYEXE%" 首次配置.py

echo.
pause >nul
