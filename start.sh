#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node.js 22+：https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "[错误] 当前 Node.js 主版本为 v${NODE_MAJOR}，需要 Node.js 22 及以上版本。"
  exit 1
fi

echo "正在启动「微信公众号文章采集、订阅与清洗工作台」..."
exec node web-server.mjs --port 4546 --open
