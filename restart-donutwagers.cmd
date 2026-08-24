@echo off
setlocal EnableExtensions
set "SITE_ROOT=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to start DonutWagers.
  pause
  exit /b 1
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  tasklist /fi "PID eq %%P" /nh | findstr /i /c:"node.exe" >nul
  if not errorlevel 1 (
    echo Stopping the current DonutWagers server on port 3000...
    taskkill /pid %%P /f >nul
  )
)

ping 127.0.0.1 -n 2 >nul
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo Port 3000 is being used by another application. Close that application, then try again.
  pause
  exit /b 1
)

echo Starting the updated DonutWagers server...
start "" "http://localhost:3000/dashboard"
echo Keep this window open while DonutWagers is running.
echo.
node "%SITE_ROOT%server.js"
echo.
echo DonutWagers stopped. Review the message above, then press any key to close.
pause >nul
