@echo off
setlocal
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "PROFILE=D:\Onzo\temp\claude-clean-browser\profile"
set "PROXY=http://127.0.0.1:10808"
set "START_URL=%~1"
if not defined START_URL set "START_URL=https://claude.ai/login"

if not exist "%CHROME%" (
  echo Chrome not found: %CHROME%
  pause
  exit /b 1
)

powershell -NoProfile -Command "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 10808); $client.Close() } catch { exit 1 }"
if errorlevel 1 (
  echo Starting v2rayN...
  start "" "D:\Tools\v2rayN\v2rayN-windows-64\v2rayN.exe"
  powershell -NoProfile -Command "$ready = $false; for ($i = 0; $i -lt 30; $i++) { $client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 10808); $client.Close(); $ready = $true; break } catch { Start-Sleep -Seconds 1 } }; if (-not $ready) { exit 1 }"
)
if errorlevel 1 (
  echo Proxy 127.0.0.1:10808 is unavailable.
  pause
  exit /b 1
)

if not exist "%PROFILE%" mkdir "%PROFILE%"
start "Claude Clean" "%CHROME%" --user-data-dir="%PROFILE%" --proxy-server="%PROXY%" --disable-extensions --disable-sync --no-first-run --no-default-browser-check --new-window "%START_URL%"
endlocal
