@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [TapNow Studio] Node.js was not found. Install Node.js 22.12+ or 24+: https://nodejs.org/
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [TapNow Studio] npm was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" goto edge_ready
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" goto edge_ready
echo [TapNow Studio] Microsoft Edge was not found; install Edge to use Muse/Doubao accounts.
goto ready_browser
:edge_ready
echo [TapNow Studio] Using system Microsoft Edge for Muse/Doubao accounts.
:ready_browser
echo.
echo TapNow Studio: http://127.0.0.1:5173
echo Checking GitHub changes and installing missing libraries before launch...
echo Local browser profiles, account data and generated media are not overwritten.
echo The launcher reuses services already running on ports 3701 / 5173.
echo Close this window to stop only the services started by this window.
echo.
call npm run dev
if errorlevel 1 (
  echo.
  echo [TapNow Studio] Failed to start; see messages above.
) else (
  echo.
  echo [TapNow Studio] Launcher finished; already running services stay active.
)
pause
