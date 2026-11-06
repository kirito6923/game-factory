@echo off
setlocal
title AI Game Factory - Shutdown
echo Stopping the local proxy on port 8787...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  if not "%%p"=="0" (
    echo    closing PID %%p
    taskkill /F /PID %%p >nul 2>&1
  )
)
echo.
echo Proxy stopped. Close the browser page if still open.
echo.
pause
