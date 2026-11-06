@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ==============================
echo    游戏工厂 · 检查更新
echo ==============================
echo.
node.exe 自动更新.js
echo.
pause
