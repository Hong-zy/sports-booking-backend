# 运动场馆易约 · 生产部署镜像
# 基础镜像固定 Node 24（node:sqlite 内置模块在 24 上无需额外 flag）
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3000

# 只复制运行所需目录，利用 Docker 分层缓存
COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared

# 数据库目录（默认 /app/data/app.db）。挂载持久化磁盘时把磁盘挂到 /app/data 即可。
RUN mkdir -p /app/data

EXPOSE 3000

# 平台（Render/Railway 等）会用 PORT 环境变量注入端口；本地默认 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "backend/src/server.js"]
