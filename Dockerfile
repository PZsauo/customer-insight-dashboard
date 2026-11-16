# ============================================================
# 客户数据信息统计驾驶舱 —— 容器镜像
# 零外部依赖：仅 Node 运行时；WorkBuddy SDK 已内置于 vendor/。
# 构建：docker build -t customer-insight-dashboard .
# 运行：docker run -d -p 3000:3000 --name cid \
#         -v cid_data:/app/data -v cid_public:/app/public/data \
#         customer-insight-dashboard
# ============================================================
FROM node:20-alpine

LABEL org.opencontainers.image.title="客户数据信息统计驾驶舱" \
      org.opencontainers.image.description="字段元数据驱动的客户数据驾驶舱，支持本地文件 / 云数据库持久化"

WORKDIR /app

# 只拷贝运行所需文件（不含 node_modules：本项目零外部 npm 依赖）
COPY server.js storage.js local-store.js cloud-store.js package.json ./
COPY public/ ./public/
COPY vendor/ ./vendor/
COPY data/storage.json.example ./data/storage.json.example
COPY data/cloud-config.json.example ./data/cloud-config.json.example

# 默认 local 模式：复制存储配置模板为生效配置
RUN cp data/storage.json.example data/storage.json \
    && mkdir -p data logs \
    && addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DRIVER=local \
    TZ=Asia/Shanghai

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
