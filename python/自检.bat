@echo off
title 学术galgame Agent - 自检
cd /d "%~dp0"

echo.
echo   正在运行 19 项自检，不联网、不花钱，大约 1 秒。
echo.

python -m unittest discover -s tests -v

echo.
echo   如果上面最后一行是 OK，说明引擎一切正常。
echo.
pause >nul
