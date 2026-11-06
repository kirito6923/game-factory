@echo off
setlocal
title AI Game Factory - Diagnose
cd /d "%~dp0"

echo Starting proxy and opening the self-check page...
start "" /min "%~dp0node.exe" "%~dp0deepseek-proxy.js"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8787/check"

echo.
echo Self-check page opened. It will tell you what is wrong.
echo Keep the black window (proxy) running, then report the result.
echo.
pause
