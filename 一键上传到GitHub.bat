@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ==============================
echo    上传游戏工厂到 GitHub
echo ==============================
echo.
node.exe _推送到GitHub.js
echo.
pause
