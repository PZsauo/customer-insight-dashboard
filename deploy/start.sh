#!/usr/bin/env bash
# ============================================================
# 客户数据信息统计驾驶舱 —— 一键启动脚本（Linux / macOS）
# 用法：
#   chmod +x start.sh
#   ./start.sh                 # 前台运行，Ctrl+C 停止
#   ./start.sh -d              # 后台运行（日志写入 logs/app.log）
#   PORT=8080 ./start.sh       # 临时指定端口
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."          # 切到应用根目录
APP_DIR="$(pwd)"

# 1. 读取 .env（若存在）：仅解析 KEY=VALUE，忽略注释与空行
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-3000}"
STORAGE_DRIVER="${STORAGE_DRIVER:-local}"
DAEMON=0
[ "${1:-}" = "-d" ] && DAEMON=1

# 2. 检查 Node.js（要求 >= 18：内置 fetch/crypto 被 SDK 与应用使用）
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node。请先安装 Node.js 18 或更高版本：https://nodejs.org/" >&2
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js 版本过低（当前 $(node -v)，需要 >= 18）。请升级后重试。" >&2
  exit 1
fi

# 3. 首次初始化：默认 local 模式需要种子文件（发行包已内置，这里做兜底）
mkdir -p data public/data public/config logs
[ -f data/storage.json ] || cp -n data/storage.json.example data/storage.json 2>/dev/null || true

# 收紧敏感文件权限（Windows 文件系统不支持 POSIX 权限位，此步会被忽略，属正常）
for f in data/.session-secret data/users.json data/cloud-config.json; do
  [ -f "$f" ] && chmod 600 "$f" 2>/dev/null || true
done

echo "──────────────────────────────────────────────"
echo " 客户数据信息统计驾驶舱"
echo " 目录     : $APP_DIR"
echo " Node     : $(node -v)"
echo " 端口     : $PORT"
echo " 存储驱动 : $STORAGE_DRIVER"
echo " 访问地址 : http://localhost:${PORT}"
echo "──────────────────────────────────────────────"

if [ "$DAEMON" -eq 1 ]; then
  if command -v nohup >/dev/null 2>&1; then
    nohup node server.js > logs/app.log 2>&1 &
    echo "$!" > logs/app.pid
    echo "✓ 已在后台启动，PID $(cat logs/app.pid)"
    echo "  日志：logs/app.log    停止：kill \$(cat logs/app.pid) 或 ./stop.sh"
  else
    echo "✗ 当前环境不支持后台运行（缺少 nohup），请去掉 -d 前台运行。" >&2
    exit 1
  fi
else
  echo " 前台运行中，按 Ctrl+C 停止。"
  exec node server.js
fi
