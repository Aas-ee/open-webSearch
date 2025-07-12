# 使用官方 Node.js 18 Alpine 基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci || npm install && npm cache clean --force

# 拷贝源码
COPY . .

# 构建项目
RUN npm run build

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 更改文件所有权
RUN chown -R nodejs:nodejs /app
USER nodejs

# 设置环境变量
ENV NODE_ENV=production
# 默认端口设置，可被部署环境覆盖
ENV PORT=3000

# 暴露端口（使用ARG允许构建时覆盖）
EXPOSE ${PORT}

# 启动命令
CMD ["node", "build/index.js"]
