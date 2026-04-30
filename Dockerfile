FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# 安装 markitdown (需 python 环境)
RUN apt-get update && apt-get install -y python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install markitdown --break-system-packages

# 复制项目文件
COPY package*.json ./
RUN npm install --production

COPY . .

# 暴露端口
EXPOSE 3000

# 启动服务
CMD ["npm", "start"]
