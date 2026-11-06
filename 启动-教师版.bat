@echo off
setlocal
title AI Game Factory - Teacher
cd /d "%~dp0"

if not exist "%~dp0node.exe" (
  echo [ERROR] node.exe not found. Package incomplete.
  pause
  exit /b 1
)

echo [1/4] Closing any old copy that is still holding port 8787...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  if not "%%p"=="0" (
    echo       old process PID %%p - closing it
    taskkill /F /PID %%p >nul 2>&1
  )
)
timeout /t 1 /nobreak >nul

echo [2/4] Starting local proxy...
start "" /min "%~dp0node.exe" "%~dp0deepseek-proxy.js"

echo [3/4] Waiting for proxy to be ready (old PCs may need up to 40s)...
set /a n=0
:wait
set /a n+=1
netstat -an | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 goto ready
if %n% geq 40 goto timeout
timeout /t 1 /nobreak >nul
goto wait

:ready
echo       Proxy is ready (took %n% seconds).
echo [4/4] Verifying which version is running...
powershell -NoProfile -Command "try{$v=(New-Object Net.WebClient).DownloadString('http://127.0.0.1:8787/version');Write-Host ('      Running: '+$v)}catch{Write-Host '      (version check skipped)'}"
echo [4/4] Opening TEACHER page...
start "" "http://127.0.0.1:8787/teacher"
goto done

:timeout
echo.
echo [WARN] Proxy did not start within 40 seconds.
echo        Opening page anyway - it may not work. Run check.bat to diagnose.
echo.
start "" "http://127.0.0.1:8787/teacher"

:done
echo.
echo Keep the small black window running. Use shutdown.bat to stop.
echo.
pause
