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
  echo [错误] 未检测到便携版 runtime\node.exe，且系统未安装 Node.js。
  echo 请下载并安装 Node.js 22+：https://nodejs.org/
  echo 或者直接下载带内置运行时的 Windows 绿色便携版压缩包。
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('"%NODE_BIN%" -p "Number(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%v"
if "%NODE_MAJOR%"=="" set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 22 (
  echo.
  echo [错误] 当前 Node.js 主版本为 v%NODE_MAJOR%，本工具的微信读书通道需要 Node.js 22 及以上版本（内置原生 WebSocket）。
  echo 请前往 https://nodejs.org/ 升级 Node.js，或使用绿色便携版。
  echo.
  pause
  exit /b 1
)

echo 正在启动「微信公众号文章采集、订阅与清洗工作台」...
echo 使用运行时：%NODE_BIN%
echo.
"%NODE_BIN%" web-server.mjs --port 4546 --open
if errorlevel 1 (
  echo.
  echo 服务异常退出，请查看上方报错信息。
  pause
)
