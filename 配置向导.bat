@echo off
chcp 65001 >nul
cd /d "%~dp0"
node.exe _配置向导.js
pause
