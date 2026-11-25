@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_BIN="
if exist "%~dp0runtime\node.exe" (
  set "NODE_BIN=%~dp0runtime\node.exe"
) else (
  where node >nul 2>nul
  if not errorlevel 1 (
    set "NODE_BIN=node"
  )
)

if "%NODE_BIN%"=="" (
  echo.
  echo [ERROR] Node.js 22+ not found ^(neither runtime\node.exe nor system node^).
  echo Please install Node.js 22+ from https://nodejs.org/ or use the Windows portable ZIP.
  echo.
  pause
  exit /b 1
)

"%NODE_BIN%" -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js 22+ is required ^(native WebSocket needed for WeRead channel^).
  "%NODE_BIN%" -v
  echo Please upgrade Node.js from https://nodejs.org/ or use the Windows portable ZIP.
  echo.
  pause
  exit /b 1
)

echo Starting WeChat Article Workbench on http://127.0.0.1:4546 ...
echo Runtime: %NODE_BIN%
echo.
"%NODE_BIN%" web-server.mjs --port 4546 --open
if errorlevel 1 (
  echo.
  echo [ERROR] Server exited unexpectedly. Check the error output above.
  pause
)
