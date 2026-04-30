#!/bin/bash
# 本地启动脚本 – 运行项目服务器

# 进入项目根目录
cd "$(dirname "$0")"

# 确保使用 npx tsx 执行 src/index.ts（与 package.json 中的 start 脚本保持一致）
# 若已经在 package.json 中定义了 start，直接使用 npm start
npm start
