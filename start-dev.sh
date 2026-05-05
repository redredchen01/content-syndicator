#!/bin/bash
# 开发启动脚本 — 检查依赖、启动项目

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Content Syndicator - 开发环境启动${NC}"
echo -e "${GREEN}========================================${NC}"

# 进入项目根目录
cd "$(dirname "$0")"

# 1. 检查 Node.js 版本
echo -e "\n${YELLOW}检查 Node.js 版本...${NC}"
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}❌ Node.js 版本过低（需要 >=18.0.0，当前 $(node -v)）${NC}"
  exit 1
fi
echo -e "${GREEN}✅ Node.js $(node -v)${NC}"

# 2. 检查 npm
echo -e "\n${YELLOW}检查 npm...${NC}"
if ! command -v npm &> /dev/null; then
  echo -e "${RED}❌ npm 未安装${NC}"
  exit 1
fi
echo -e "${GREEN}✅ npm $(npm -v)${NC}"

# 3. 检查 Docker（如使用 Docker 模式）
if [ "$1" = "docker" ]; then
  echo -e "\n${YELLOW}检查 Docker...${NC}"
  if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker 未安装${NC}"
    exit 1
  fi
  echo -e "${GREEN}✅ Docker $(docker --version)${NC}"
fi

# 4. 安装依赖
echo -e "\n${YELLOW}安装项目依赖...${NC}"
if [ ! -d "node_modules" ]; then
  npm install
else
  echo -e "${GREEN}✅ node_modules 已存在${NC}"
fi

# 5. 运行启动前检查
echo -e "\n${YELLOW}运行启动前检查...${NC}"
npm run preflight || {
  echo -e "${YELLOW}⚠️  启动检查有警告，继续启动...${NC}"
}

# 6. 选择启动模式
echo -e "\n${YELLOW}选择启动模式：${NC}"
echo "  1. 直接启动 (npm start)"
echo "  2. Docker Compose 启动 (docker-compose -f docker-compose.dev.yml up)"
read -p "请选择 (1/2): " choice

case $choice in
  1)
    echo -e "\n${GREEN}📦 直接启动项目...${NC}"
    npm start
    ;;
  2)
    echo -e "\n${GREEN}🐳 Docker Compose 启动项目...${NC}"
    docker-compose -f docker-compose.dev.yml up
    ;;
  *)
    echo -e "${RED}❌ 无效的选择${NC}"
    exit 1
    ;;
esac
