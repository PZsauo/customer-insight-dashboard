#!/usr/bin/env bash
# 停止后台运行的驾驶舱（配合 start.sh -d 使用）
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f logs/app.pid ]; then
  PID="$(cat logs/app.pid)"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" && echo "✓ 已停止 PID $PID"
  else
    echo "进程 $PID 已不在运行。"
  fi
  rm -f logs/app.pid
else
  echo "未找到 logs/app.pid，服务可能未以后台方式启动。"
fi
