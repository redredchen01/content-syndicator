#!/bin/bash

# ==========================================
# Content Syndicator Agent - Local Launcher
# ==========================================

# 1. 切换到脚本所在目录
CD_PATH="$(dirname "$0")"
cd "$CD_PATH"

echo "------------------------------------------"
echo "🚀 正在启动 Content Syndicator Agent..."
echo "------------------------------------------"

# 2. 检查依赖是否安装
if [ ! -d "node_modules" ]; then
    echo "⚠️  未发现 node_modules，正在尝试自动安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败，请检查网络或手动运行 npm install"
        read -p "按回车键退出..."
        exit 1
    fi
fi

# 3. 启动服务
echo "✅ 环境检查完毕，正在启动 Web 服务..."
echo "🌐 启动后请访问: http://localhost:3000"
echo "------------------------------------------"

# 使用 npm start 启动 (对应 tsx src/index.ts)
npm start

# 4. 防止窗口意外关闭
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ 服务启动失败或已停止。"
    read -p "按回车键退出..."
fi
