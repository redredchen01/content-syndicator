# 开发者文档（DEVELOPMENT.md）

**快速上手 | 模块地图 | 调试指南 | 常见问题**

[English](./DEVELOPMENT.en.md) | 中文

---

## 快速启动（5 分钟）

### 前置要求
- Node.js ≥ 18.0.0
- npm ≥ 9.0.0
- （可选）Docker & docker-compose
- （可选）VSCode（调试推荐）

### 本地启动

**方式 1：直接启动（快速）**

```bash
# 1. 克隆并进入项目
git clone <repo-url>
cd <project>

# 2. 安装依赖
npm install

# 3. 启动项目（自动运行启动前检查）
npm start

# 4. 验证（在另一个终端）
curl http://localhost:3000/health
# 预期输出：{"status":"ok","version":"0.2.0","uptime":...}
```

**方式 2：Docker 启动（推荐开发）**

```bash
# 使用开发版 docker-compose（支持热重载）
./start-dev.sh
# 或手动运行
docker-compose -f docker-compose.dev.yml up
```

**方式 3：VSCode 调试启动**

1. 在 VSCode 中打开项目
2. 按 `F5` 或 Debug → Start Debugging
3. 选择 "Debug: 直接启动（Node.js + tsx）"
4. 在代码中设置断点（点击行号左侧）
5. 项目会启动并在断点处暂停

---

## 项目结构

### 核心 13 模块

详见 `/src/ARCHITECTURE.md`（已自动生成）

```
src/
├── routes/              # Express 路由层（5 个子路由）
├── services/            # 业务逻辑层（publish, queue, scheduler 等）
├── adapters/            # 平台适配器（7 个发布平台）
├── db/                  # 数据库层（SQLite 单例 + repositories）
├── llm/                 # LLM 客户端（OpenAI/Gemini）
├── utils/               # 工具库（logger, smartRetry, context, 等）
├── agent/               # AI Agent 框架
├── sheets/              # Google Sheets 聚合
├── scraper/             # 网页爬取
├── cache/               # 缓存管理
├── types/               # 类型定义
├── prompts/             # LLM Prompt 模板
└── middleware/          # Express 中间件
```

### 关键目录

```
.
├── docs/                # 文档（ARCHITECTURE.md, module-graph.md, etc）
├── .vscode/             # VSCode 调试配置
├── scripts/             # 工具脚本（preflight-check.ts, check-circular-deps.ts）
├── .data/               # 本地数据
│   ├── syndicator.db    # SQLite 数据库
│   ├── logs/            # 日志文件（按日期）
│   └── ...
└── docker-compose.*.yml # Docker 配置（生产/开发）
```

---

## 模块依赖关系

详见 `/docs/module-graph.md`（已自动生成）

**依赖方向（严格单向）：**

```
utils
  ↓
db, llm, agent, cache, scraper
  ↓
services (publish, scheduler, browser-session, etc)
  ↓
routes (HTTP 端点)
```

**通信约定：** 详见 `/src/COMMUNICATION_CONTRACTS.md`

每个模块间的调用遵循统一的返回值格式：

```typescript
// 标准返回值
{
  ok: boolean,
  data?: T,
  error?: string,
  contextId?: string
}
```

---

## 常见开发任务

### 1. 如何调试一个 API 请求

**场景：** 发布到 Blogger 失败，需要追踪完整流程

**步骤：**

1. **通过日志查找 contextId**

   ```bash
   # 查看最新日志
   tail -f .data/logs/app-*.log
   
   # 或通过 API 端点查询日志（若已实现）
   curl http://localhost:3000/api/logs?level=error
   ```

2. **使用 contextId 追踪完整链路**

   ```bash
   # 收集该请求的所有日志
   grep "contextId=<id>" .data/logs/app-*.log
   
   # 输出示例：
   # 2026-05-05 13:45:22 [routes.publish.generate.start] contextId=abc-123 draft=...
   # 2026-05-05 13:45:23 [services.publish.quality_gate] contextId=abc-123 platform=blogger score=8.5
   # 2026-05-05 13:45:24 [adapters.blogger.publish_start] contextId=abc-123 title=...
   # 2026-05-05 13:45:25 [adapters.blogger.publish_error] contextId=abc-123 error=401 Unauthorized
   ```

3. **在 VSCode 中设置断点**

   - 打开 `src/adapters/blogger.ts` 的 `publish()` 方法
   - 在认证检查处设置断点
   - 按 F5 启动调试器
   - 触发请求（通过 curl 或 Postman）
   - 调试器会在断点处暂停

4. **查看变量和调用栈**

   - 在 VSCode Debug 面板查看局部变量
   - 检查 error 对象的详细内容
   - 单步执行（F10）或继续（F5）

### 2. 如何支持新的发布平台

**示例：** 添加对 Reddit 的支持

1. **创建 adapter**

   ```bash
   touch src/adapters/reddit.ts
   ```

2. **实现 Adapter 接口**

   ```typescript
   // src/adapters/reddit.ts
   import { PublishAdapter, PublishResult } from '../types';
   
   export class RedditAdapter implements PublishAdapter {
     async publish(options: PublishOptions): Promise<PublishResult> {
       // 实现发布逻辑
       logger.info('adapters.reddit.publish_start', { ...options });
       try {
         const result = await this.postToReddit(options);
         return { ok: true, data: result };
       } catch (err) {
         logger.error('adapters.reddit.publish_error', { error: err.message });
         return { ok: false, error: err.message };
       }
     }
     
     private async postToReddit(options: PublishOptions) {
       // 调用 Reddit API
       // ...
     }
   }
   ```

3. **注册到 adapter 工厂**

   ```typescript
   // src/adapters/index.ts
   import { RedditAdapter } from './reddit';
   
   export function getAdapter(platform: string): PublishAdapter {
     switch (platform) {
       case 'reddit':
         return new RedditAdapter();
       // ...
     }
   }
   ```

4. **编写单元测试**

   ```bash
   touch src/adapters/__tests__/reddit.test.ts
   ```

   ```typescript
   // src/adapters/__tests__/reddit.test.ts
   import { describe, it, expect, vi } from 'vitest';
   import { RedditAdapter } from '../reddit';
   
   vi.mock('node-fetch'); // Mock HTTP 调用
   
   describe('RedditAdapter', () => {
     it('should successfully post to Reddit', async () => {
       const adapter = new RedditAdapter();
       const result = await adapter.publish({
         title: 'Test Post',
         markdownContent: 'Test content',
         // ...
       });
       expect(result.ok).toBe(true);
     });
   });
   ```

5. **运行测试**

   ```bash
   npm test -- src/adapters/__tests__/reddit.test.ts
   ```

6. **更新类型和文档**

   - 在 `src/types/index.ts` 中添加 'reddit' 到平台枚举
   - 在 `src/ARCHITECTURE.md` 中添加新 adapter 的描述

### 3. 如何添加新的 API 端点

**示例：** 添加 `POST /api/v2/test-adapter` 用于测试任意 adapter

1. **创建路由处理器**

   ```typescript
   // src/routes/test.ts
   import { Router } from 'express';
   import { asyncRoute } from './_helpers';
   
   export const testRouter = Router();
   
   testRouter.post('/test-adapter', asyncRoute(async (req, res) => {
     const { platform, title, content } = req.body;
     
     logger.info('routes.test.start', { platform });
     
     const adapter = getAdapter(platform);
     const result = await adapter.publish({ title, markdownContent: content });
     
     if (result.ok) {
       logger.info('routes.test.success', { platform, url: result.data });
       return res.json({ ok: true, publishedUrl: result.data });
     } else {
       logger.error('routes.test.failed', { platform, error: result.error });
       return res.status(400).json({ ok: false, error: result.error });
     }
   }));
   ```

2. **在主路由中注册**

   ```typescript
   // src/routes/index.ts
   import { testRouter } from './test';
   
   app.use('/api/v2', testRouter);
   ```

3. **编写集成测试**

   ```typescript
   // src/routes/__tests__/test.test.ts
   import { request } from 'supertest';
   import { app } from '../../server';
   
   test('POST /api/v2/test-adapter should publish to adapter', async () => {
     const res = await request(app)
       .post('/api/v2/test-adapter')
       .send({
         platform: 'blogger',
         title: 'Test',
         content: 'Content'
       });
     
     expect(res.status).toBe(200);
     expect(res.body.publishedUrl).toBeDefined();
   });
   ```

4. **测试端点**

   ```bash
   curl -X POST http://localhost:3000/api/v2/test-adapter \
     -H "Content-Type: application/json" \
     -d '{"platform":"blogger","title":"Test","content":"Test content"}'
   ```

---

## 常见问题与排查

### Q1: 项目启动失败，提示 "Cannot find module 'tsx'"

**原因：** npm 依赖未安装或版本不匹配

**解决：**

```bash
npm install
npm start
```

### Q2: 日志文件未创建，看不到 `.data/logs/app-*.log`

**原因：** 日志目录不存在或权限问题

**解决：**

```bash
# 手动创建目录
mkdir -p .data/logs

# 或在 src/index.ts 中添加初始化代码：
import fs from 'fs';
import path from 'path';

const logsDir = path.join(process.cwd(), '.data/logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
```

### Q3: 测试失败，提示 "Cannot find module 'supertest'"

**原因：** 依赖未安装或 package.json 中缺少该模块

**解决：**

```bash
npm install --save-dev supertest
npm test
```

### Q4: Adapter 测试中 mock 不生效，HTTP 请求实际发送

**原因：** mock 在 import 之前未定义，或 mock 路径不正确

**解决：**

```typescript
// ❌ 错误：mock 在 import 之后
import { DevToAdapter } from '../devto';
vi.mock('node-fetch');

// ✅ 正确：mock 在 import 之前
vi.mock('node-fetch');
import { DevToAdapter } from '../devto';

// 或使用 manual mock 目录
// __mocks__/node-fetch.ts
```

### Q5: Docker 启动失败，container 立即退出

**原因：** 环境变量未配置或数据库初始化失败

**解决：**

```bash
# 检查容器日志
docker-compose -f docker-compose.dev.yml logs syndicator-dev

# 确保 .env 文件存在（复制自 .dev.env.example）
cp .dev.env.example .env

# 清理并重新启动
docker-compose -f docker-compose.dev.yml down -v
docker-compose -f docker-compose.dev.yml up
```

### Q6: VSCode 调试器无法启动，提示 "Error: spawn tsx ENOENT"

**原因：** tsx 未全局安装或 PATH 未正确配置

**解决：**

```bash
# 使用本地 tsx
npm install -g tsx

# 或修改 .vscode/launch.json 使用完整路径
"program": "${workspaceFolder}/node_modules/.bin/tsx",
```

### Q7: 断点设置后无法暂停，调试器继续运行

**原因：** breakpoint 模式未正确配置

**解决：**

```json
// .vscode/launch.json
{
  "stopOnEntry": false,  // 不在程序入口暂停
  "sourceMapPathOverride": {
    "${workspaceFolder}/src/*": "${workspaceFolder}/src/*"
  }
}
```

然后手动在代码中添加 `debugger;` 语句强制暂停。

---

## 调试技巧

### 使用 DEBUG 环境变量

```bash
# 仅输出 content-syndicator 相关日志
DEBUG=content-syndicator:* npm start

# 调试特定模块
DEBUG=content-syndicator:routes npm start
DEBUG=content-syndicator:services npm start
```

### 使用 contextId 追踪请求

每个请求自动生成唯一的 contextId（或从请求头获取）。所有日志都包含 contextId，便于追踪：

```bash
# 查看某个请求的完整流程
grep "contextId=abc-123-def" .data/logs/app-*.log | less

# 或使用 jq 解析 JSON 日志
cat .data/logs/app-*.log | jq 'select(.contextId == "abc-123-def")'
```

### 性能分析

使用 Node.js 内置的 profiler：

```bash
# 启动带 profiler 的服务
node --prof src/index.ts

# 处理后生成可读的报告
node --prof-process isolate-*.log > profile.txt
```

### 内存泄漏检测

```bash
# 使用 clinic.js 检测
npm install -g clinic
clinic doctor -- npm start

# 访问应用生成负载
# clinic 会生成 HTML 报告显示内存使用趋势
```

---

## 提交代码前的检查清单

在推送代码到 Git 之前，运行以下检查：

```bash
# 1. 安装依赖（若有新增）
npm install

# 2. 运行启动前检查
npm run preflight

# 3. 运行所有测试
npm test

# 4. 检查代码风格（若已配置）
npm run lint

# 5. 类型检查
npm run tsc -- --noEmit

# 一键检查：
npm run ci:check  # 若已定义此脚本
```

---

## 资源和参考

| 资源 | 链接 | 用途 |
|------|------|------|
| **ARCHITECTURE.md** | `/src/ARCHITECTURE.md` | 模块职责和接口 |
| **module-graph.md** | `/docs/module-graph.md` | 依赖关系图 |
| **COMMUNICATION_CONTRACTS.md** | `/src/COMMUNICATION_CONTRACTS.md` | 模块通信约定 |
| **REGRESSION_TEST_CHECKLIST.md** | `/docs/REGRESSION_TEST_CHECKLIST.md` | 测试覆盖清单 |
| **Winston 文档** | https://github.com/winstonjs/winston | 日志框架 |
| **Vitest 文档** | https://vitest.dev | 测试框架 |
| **Express 文档** | https://expressjs.com | Web 框架 |

---

## 贡献指南

### 新功能开发流程

1. 从 `main` 创建 feature 分支：`git checkout -b feat/my-feature`
2. 完成功能和测试
3. 运行 `npm run ci:check` 确保所有检查通过
4. 提交 PR（描述功能、关键实现、测试覆盖）
5. 等待 code review 和 CI 通过
6. 合并到 `main`

### Bug 修复流程

1. 从 `main` 创建 bugfix 分支：`git checkout -b fix/bug-description`
2. 添加回归测试再现 bug
3. 修复 bug
4. 确保测试通过
5. 提交 PR 并引用相关 issue

### 代码评审标准

- 代码遵循现有风格和约定
- 新增功能有对应的测试
- 测试覆盖率不下降
- 不引入新的 lint 或 TypeScript 错误
- 文档更新（如适用）

---

**最后更新：** 2026-05-05  
**维护者：** Debug 优化计划  
**反馈和问题：** 提交 GitHub Issue 或 PR
