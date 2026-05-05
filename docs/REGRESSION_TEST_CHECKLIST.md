---
title: Regression Test Checklist
date: 2026-05-05
type: verification
status: active
---

# 回归测试清单 — Phase 3 测试体系完整性验证

本清单用于确保新增的测试体系不会破坏既有功能，作为 CI 流程的关键检查项。所有提交前必须通过以下检查。

## 快速检查命令

```bash
# 运行全部测试
npm test

# 查看测试覆盖率
npm run test:coverage

# 按模块运行回归测试
npm test -- src/adapters/__tests__/
npm test -- src/services/__tests__/
npm test -- src/routes/__tests__/
npm test -- src/utils/__tests__/
npm test -- src/db/__tests__/
```

## 回归测试三大支柱

### 1. 适配器层回归测试（Unit 10）— 平台兼容性

| 平台 | 测试文件 | 检查项 |
|------|--------|--------|
| **Blogger** | `src/adapters/__tests__/blogger.test.ts` | ✅ 成功发布、认证失败、特殊字符、长内容 |
| **Dev.to** | `src/adapters/__tests__/devto.test.ts` | ✅ 成功发布、标签处理、原文 URL 附加、超大内容 |
| **GitHub** | `src/adapters/__tests__/github.test.ts` | ⏳ Pending（计划支持） |
| **Hashnode** | `src/adapters/__tests__/hashnode.test.ts` | ⏳ Pending |
| **Medium** | `src/adapters/__tests__/medium.test.ts` | ⏳ Pending |
| **Telegraph** | `src/adapters/__tests__/telegraph.test.ts` | ⏳ Pending |
| **WordPress** | `src/adapters/__tests__/wordpress.test.ts` | ⏳ Pending |

**关键场景：**
- ✅ Happy path：正常发布流程，返回有效 URL
- ✅ Error path：网络错误、认证失败、平台错误
- ✅ Edge cases：特殊字符、长文本、边界值

**验证命令：**
```bash
npm test -- src/adapters/__tests__/blogger.test.ts
npm test -- src/adapters/__tests__/devto.test.ts
```

**预期结果：** 所有 adapter 测试通过，覆盖率 >70%

---

### 2. 服务层回归测试（Unit 11）— 业务逻辑完整性

#### 2.1 发布服务（publish-service.ts）

测试文件：`src/services/__tests__/publish-service.test.ts`

| 场景 | 测试覆盖 | 状态 |
|------|--------|------|
| 单 variant 发布到多平台 | ✅ `should accept PublishOptions and quality score` | ✅ Pass |
| 质量门槛过滤（低质量排除高级平台） | ✅ `should apply quality gate to filter platforms` | ✅ Pass |
| 平台选择和默认配置 | ✅ `should use default platforms when not specified` | ✅ Pass |
| 标签、摘要、原文 URL 保留 | ✅ `should preserve sourceUrl for attribution` | ✅ Pass |
| 草稿 vs 公开状态 | ✅ `should support public status` | ✅ Pass |

**关键场景：**
- 多 variant 场景：所有 variant 应分别发布到对应平台
- 全部成功：返回成功计数和 URL 列表
- 部分失败：失败 variant 记录错误，成功 variant 继续发布
- 所有失败：返回详细错误，但不影响其他作业

**验证命令：**
```bash
npm test -- src/services/__tests__/publish-service.test.ts
```

**预期结果：** 21 个测试通过，覆盖率 >80%

#### 2.2 其他服务模块

- ✅ `src/services/queue/__tests__/scheduler.test.ts` — 作业调度、重试、僵尸清理
- ✅ `src/services/__tests__/anchor-monitor.test.ts` — 锚点监控
- ✅ `src/services/lint/__tests__/jaccard.test.ts` — 内容相似度检测

---

### 3. 路由层回归测试（Unit 12）— API 端点完整性

测试文件：`src/routes/__tests__/publish.integration.test.ts`

| 端点 | 测试覆盖 | 场景 |
|------|--------|------|
| **POST /api/v2/generate** | ✅ 14 个测试 | draft 验证、variant 返回、lintResult 返回 |
| **POST /api/v2/dispatch** | ✅ 5 个测试 | batchId 和 variants 验证、jobsCreated 返回 |
| **GET /api/v2/queue** | ✅ 4 个测试 | batchId 过滤、jobs 返回结构 |
| **POST /api/v2/regenerate-variant** | ✅ 4 个测试 | 参数验证（batchId、platform、draft） |
| **GET /health** | ✅ 2 个测试 | 健康检查、版本信息返回 |

**关键场景：**
- ✅ 参数验证：缺少必要字段返回 400
- ✅ Happy path：正确参数返回 200 + 预期数据结构
- ✅ 错误处理：下游服务失败返回 500 + 错误信息
- ✅ 请求头：支持 x-request-id 和 x-context-id

**验证命令：**
```bash
npm test -- src/routes/__tests__/publish.integration.test.ts
```

**预期结果：** 26 个测试通过，覆盖率 >50%

---

### 4. 工具层回归测试（Unit 13）— 基础设施稳定性

#### 4.1 错误处理（errorHandler.test.ts）

测试文件：`src/utils/__tests__/errorHandler.test.ts`

| 组件 | 测试数 | 覆盖项 |
|------|------|-------|
| errorHandler 单例 | 5 | instance、methods、clear |
| 错误分类与建议 | 4 | error handling、suggestions、advice |
| 历史记录管理 | 5 | retrieve、filter、limit、clear |
| 统计信息 | 3 | total、byType、recentErrors |
| API 错误处理 | 3 | with/without context、error details |
| 真实场景 | 4 | fetch、timeout、API response、suggestions |
| 边界情况 | 4 | null errors、no message、string errors、stack traces |

**关键场景：**
- ✅ Error 分类：network、timeout、auth、rate-limit、server-error、unknown
- ✅ 历史查询：按类型、时间、limit 过滤
- ✅ 统计信息：错误计数、按类型分布、最近 1 小时错误数
- ✅ 边界值：null、undefined、无 message、stack trace 完整

**验证命令：**
```bash
npm test -- src/utils/__tests__/errorHandler.test.ts
```

**预期结果：** 28 个测试通过，覆盖率 >95%

#### 4.2 日志集成（logger.integration.test.ts）

测试文件：`src/utils/__tests__/logger.integration.test.ts`

| 特性 | 测试数 | 验证项 |
|------|------|-------|
| 日志级别 | 5 | debug、info、warn、error、success |
| 时间戳格式 | 1 | YYYY-MM-DD HH:mm:ss.SSS |
| 文件轮转 | 2 | 日期命名、多日期文件创建 |
| Context 注入 | 1 | contextId 自动添加 |
| 并发性能 | 1 | 100 条日志 <500ms |
| 向后兼容 | 1 | 旧 API 无需修改 |

**关键场景：**
- ✅ 结构化输出：包含 timestamp、level、message、contextId
- ✅ 文件持久化：`.data/logs/app-YYYY-MM-DD.log` 按日期创建
- ✅ 并发性能：日志写入不阻塞主线程
- ✅ Context 自动注入：runWithContext 自动设置 contextId

**验证命令：**
```bash
npm test -- src/utils/__tests__/logger.integration.test.ts
```

**预期结果：** 11 个测试通过，覆盖率 >90%

#### 4.3 其他工具模块

- ✅ `src/utils/__tests__/browserManager.test.ts` — 浏览器生命周期管理
- ✅ `src/utils/__tests__/smartRetry.test.ts` — 智能重试逻辑（现有）
- ✅ `src/utils/__tests__/parallel.test.ts` — 并发控制（现有）

---

### 5. 数据库层回归测试（Unit 原有）— 数据完整性

测试文件：`src/db/__tests__/`

| 模块 | 测试数 | 覆盖项 |
|------|------|-------|
| Repositories | 22 | CRUD、查询、事务 |
| Schema | 9 | 表结构、版本、迁移 |

**关键场景：**
- ✅ CRUD 操作：插入、查询、更新、删除无污染
- ✅ 事务隔离：并发操作无竞态
- ✅ 数据约束：外键、唯一性、类型验证

**验证命令：**
```bash
npm test -- src/db/__tests__/
```

**预期结果：** 31 个测试通过，覆盖率 >90%

---

## Phase 3 整体检查清单

在合并到 main 分支前，必须确保：

### ✅ 测试覆盖完整性

- [ ] 全部测试通过：`npm test` → **317 passed**
- [ ] 覆盖率达标：
  - [ ] adapters 层 >70%（新增：blogger, devto）
  - [ ] services 层 >80%（新增：publish-service, scheduler）
  - [ ] routes 层 >50%（新增：publish 集成测试）
  - [ ] utils 层 >90%（新增：errorHandler, logger）
  - [ ] db 层 >90%（已有）
- [ ] 无测试警告或错误：`npm test 2>&1 | grep -i "error\|warn"` → 无结果

### ✅ 日志系统完整性

- [ ] Logger 配置：`src/utils/logger-config.ts` 存在
- [ ] Context 追踪：`src/utils/context.ts` 实现 cls-hooked
- [ ] 日志文件创建：`.data/logs/app-*.log` 按日期存在
- [ ] 关键路径埋点：
  - [ ] routes 层：发布、查询、管理端点
  - [ ] services 层：publish-service、variant-generator、scheduler
  - [ ] adapters 层：blogger、devto 等平台发布记录

### ✅ 模块治理完整性

- [ ] ARCHITECTURE.md 文档完成
- [ ] module-graph.md 依赖图完成
- [ ] COMMUNICATION_CONTRACTS.md 通信约定完成
- [ ] check-circular-deps.ts 脚本存在且无告警

### ✅ 代码质量

- [ ] 无 lint 错误：`npm run lint` 通过
- [ ] 无 TypeScript 错误：`npm run tsc --noEmit` 通过
- [ ] 代码风格一致：现有模式遵循

### ✅ CI 集成

- [ ] 所有测试在 CI 流程中通过
- [ ] 覆盖率报告生成
- [ ] 无新增警告

---

## 常见失败排查

### ❌ "errorHandler.clear is not a function"
**解决：** 使用 `errorHandler.clearHistory()` 而非 `clear()`

### ❌ "日志文件不存在"
**解决：** 确保 `.data/logs/` 目录存在，或在 index.ts 启动时创建：
```typescript
const logsDir = path.join(process.cwd(), '.data/logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
```

### ❌ "Context ID 未被注入"
**解决：** 确保在路由中使用 `runWithContext(contextId, async () => { ... })`

### ❌ "Adapter 测试 mock 失败"
**解决：** 使用 `vi.mock()` mock 整个模块，而非单个函数

### ❌ "Database 测试污染"
**解决：** 使用 `:memory:` SQLite 和 `applyV2Schema(db)` 隔离测试

---

## 下一步（Phase 4）

Phase 3 完成后，将进入 Phase 4 - 本地开发工具链优化：

- Unit 15：docker-compose.dev.yml 和启动脚本
- Unit 16：VSCode 调试配置（.vscode/launch.json）
- Unit 17：开发者文档（DEVELOPMENT.md）
- Unit 18：启动检查脚本与 CI 集成

预期效果：新人能 5 分钟内启动项目，10 分钟内调试任意端点。

---

**最后更新：** 2026-05-05  
**负责人：** Debug 优化计划执行  
**状态：** Phase 3 完成，全部 317 测试通过
