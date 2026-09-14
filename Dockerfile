# 学术galgame Agent · 容器镜像
# 项目零运行时依赖，因此无需 npm install，镜像极小、启动极快。
FROM node:20-alpine

WORKDIR /app

# 只复制运行所需文件（零依赖，无需 package-lock / node_modules）
COPY package.json ./
COPY src ./src
COPY corpus ./corpus
COPY docs ./docs
COPY README.md LICENSE ./

# 云平台要求监听 0.0.0.0；PORT 由平台注入（server.js 会读取 process.env.PORT）
ENV HOST=0.0.0.0
ENV PORT=8787
ENV NODE_ENV=production

EXPOSE 8787

# 健康检查（部署平台可直接用 /api/health）
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/server.js"]
