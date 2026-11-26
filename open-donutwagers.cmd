@echo off
setlocal
set "SITE_ROOT=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run DonutWagers. Install Node.js, then run this file again.
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting DonutWagers on http://localhost:3000 ...
  start "DonutWagers Server" /min cmd /c "cd /d ""%SITE_ROOT%"" && node server.js"
  timeout /t 2 /nobreak >nul
)

start "" "http://localhost:3000/"
echo DonutWagers opened in your default browser.
echo Use http://localhost:3000/ - do not open the project files directly.
timeout /t 2 /nobreak >nul
