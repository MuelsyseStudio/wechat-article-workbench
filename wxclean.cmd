@echo off
setlocal EnableExtensions
chcp 65001 >nul

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
  echo [ERROR] Node.js 22+ not found ^(neither runtime\node.exe nor system node^).
  echo Install Node.js 22+ from https://nodejs.org/ or use the Windows portable ZIP.
  exit /b 1
)

"%NODE_BIN%" "%~dp0cli.mjs" %*
exit /b %errorlevel%
