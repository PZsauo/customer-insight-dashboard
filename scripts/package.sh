#!/usr/bin/env bash
# ============================================================
# 打包脚本：生成干净的部署安装包（目录 + tar.gz）
# 用法：bash scripts/package.sh [输出目录]
#   默认输出：../customer-insight-dashboard-release/
# 产物：
#   customer-insight-dashboard/  可直接部署的应用目录
#   customer-insight-dashboard.tar.gz  便于传输的单文件安装包
# ============================================================
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$(dirname "$SRC")/customer-insight-dashboard-release}"
PKG="customer-insight-dashboard"
VERSION="$(grep -m1 '"version"' "$SRC/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
STAGE="$OUT/$PKG"

echo "──────────────────────────────────────────────"
echo " 打包客户数据信息统计驾驶舱  v$VERSION"
echo " 源目录 : $SRC"
echo " 输出   : $STAGE"
echo "──────────────────────────────────────────────"

rm -rf "$STAGE"
mkdir -p "$STAGE"/{deploy,data,public/config,public/data,public/css,public/js,vendor,scripts}

# 1. 后端核心 + 前端静态资源 + 内置 SDK
cp "$SRC"/{server.js,storage.js,local-store.js,cloud-store.js,package.json,README.md,Dockerfile,docker-compose.yml,.env.example} "$STAGE/"
cp "$SRC"/public/index.html "$STAGE/public/"
cp "$SRC"/public/css/style.css "$STAGE/public/css/"
cp "$SRC"/public/js/app.js "$STAGE/public/js/"
cp "$SRC"/public/js/charts.js "$STAGE/public/js/"
cp "$SRC"/public/config/fields.json "$STAGE/public/config/"
cp "$SRC"/public/data/customers.json "$STAGE/public/data/"
cp -R "$SRC"/vendor/workbuddy-cloud-sdk "$STAGE/vendor/"
cp "$SRC"/scripts/generate-demo-data.js "$STAGE/scripts/"
cp "$SRC"/scripts/package.sh "$STAGE/scripts/"

# 2. 部署脚本与服务文件
cp "$SRC"/deploy/start.sh "$SRC"/deploy/start.bat "$SRC"/deploy/stop.sh "$STAGE/deploy/"
cp "$SRC"/deploy/customer-insight-dashboard.service "$STAGE/deploy/"

# 3. 配置模板：默认 local；不携带任何真实凭据/会话密钥/账号哈希
cp "$SRC"/data/storage.json.example "$STAGE/data/storage.json"
cp "$SRC"/data/storage.json.example "$STAGE/data/storage.json.example"
cp "$SRC"/data/cloud-config.json.example "$STAGE/data/cloud-config.json.example"
# 首次启动自动生成 .session-secret 与 data/users.json（不随包分发）

# 4. 权限：脚本可执行
chmod +x "$STAGE"/deploy/*.sh "$STAGE/scripts/"*.sh 2>/dev/null || true

# 5. 生成 tar.gz（在 OUT 目录内，使解压后顶层为应用目录）
cd "$OUT"
rm -f "$PKG.tar.gz"
if command -v tar >/dev/null 2>&1; then
  tar -czf "$PKG.tar.gz" "$PKG"
  echo "✓ 已生成 $OUT/$PKG.tar.gz ($(du -h "$PKG.tar.gz" | cut -f1))"
else
  echo "⚠ 未找到 tar，仅生成目录（可手动压缩）"
fi

# 6. 校验：确保发行包没有敏感文件、默认 local
echo "=== 发行包校验 ==="
if [ -f "$STAGE/data/.session-secret" ]; then echo "✗ 检测到 .session-secret，应删除！"; exit 1; else echo "✓ 无 .session-secret"; fi
if [ -f "$STAGE/data/users.json" ]; then echo "✗ 检测到 users.json，应由首次启动生成！"; exit 1; else echo "✓ 无 users.json（首次启动生成管理员）"; fi
if [ -f "$STAGE/data/cloud-config.json" ]; then echo "✗ 检测到真实 cloud-config.json，应移除！"; exit 1; else echo "✓ 无真实 cloud-config.json"; fi
grep -q '"driver"[[:space:]]*:[[:space:]]*"local"' "$STAGE/data/storage.json" && echo "✓ 默认驱动 local" || { echo "✗ 默认驱动不是 local"; exit 1; }
[ -f "$STAGE/vendor/workbuddy-cloud-sdk/lib/index.cjs" ] && echo "✓ 内置 SDK 存在" || { echo "✗ 缺少内置 SDK"; exit 1; }
echo "✓ 文件数：$(find "$STAGE" -type f | wc -l | tr -d ' ')"
echo "✓ 完成：$STAGE"
