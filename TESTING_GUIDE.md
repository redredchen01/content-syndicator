# 本地测试指南 (Local Testing Guide)

## 🚀 启动服务器

服务器已启动！访问:

- **主页**: http://localhost:3000
- **Onboarding 向导**: http://localhost:3000/onboarding.html
- **品牌档案管理**: http://localhost:3000/admin.html
- **健康检查**: http://localhost:3000/health

---

## ✅ 功能测试清单

### 1️⃣ Onboarding 向导 (新流程)

访问: http://localhost:3000/onboarding.html

**测试步骤 1: 品牌档案创建**
- [ ] 输入品牌名称 (如: "我的品牌")
- [ ] 输入网站 URL (如: https://example.com)
- [ ] 点击"继续"进入下一步
- [ ] ✅ 验证: 步骤指示器更新，品牌信息保存

**测试步骤 2: API 渠道配置**
- [ ] 选择 Dev.to、Medium 等平台
- [ ] 输入 API 密钥 (可使用测试密钥)
- [ ] 失焦时自动验证，显示结果
- [ ] ✅ 验证: 
  - 成功: ✓ 验证成功 (绿色)
  - 失败: ✗ 错误信息 (红色)
  - 无重复请求 (检查网络面板)

**测试步骤 3: 浏览器自动化 (可选)**
- [ ] 勾选/取消"启用浏览器自动化"
- [ ] 点击"继续"

**测试步骤 4: 首选平台选择**
- [ ] 看到已连接的平台列表
- [ ] 选择默认发布平台
- [ ] 点击"完成设置"
- [ ] ✅ 验证: 重定向到 admin.html

---

### 2️⃣ 平台管理面板 (优化后)

访问: http://localhost:3000/admin.html

**平台管理部分测试**
- [ ] 看到"发布平台管理"区域
- [ ] 每个平台显示:
  - 名称和连接状态 (绿/红)
  - 最后错误信息
  - 测试时间戳
  - 默认平台标签

**快速添加 API 密钥测试**
- [ ] 点击平台旁的"连接"或"更新"按钮
- [ ] 快速添加表单出现
- [ ] 选择平台，输入 API 密钥
- [ ] 提交验证
- [ ] ✅ 验证:
  - 成功消息后自动关闭
  - 平台列表自动刷新
  - 无重复请求

**缓存性能测试**
- [ ] 快速刷新页面多次
- [ ] 观察网络面板:
  - 第 1 次: 新请求
  - 第 2-3 次 (< 10 秒内): 应使用缓存
  - 第 4 次 (> 10 秒): 新请求
- [ ] ✅ 验证: 缓存命中率 > 80%

---

### 3️⃣ 性能优化验证

**A. 请求去重 (Onboarding)**
1. 打开浏览器开发者工具 → Network 标签
2. 在 onboarding.html 的 API 密钥输入框快速输入
3. 观察网络请求
   - ✅ 验证: 只有 1 个验证请求，不是 3-5 个

**B. 并发凭证验证**
1. 在 admin 面板快速添加 3 个 API 密钥
2. 监控服务器日志
   - ✅ 验证: 应看到并行处理信息

**C. 诊断端点**
```bash
curl http://localhost:3000/api/diagnostics/setup-status
```
预期响应:
```json
{
  "profileConfigured": true,
  "dispatchReady": false,
  "connectedPlatforms": 2,
  "totalPlatforms": 22,
  "issues": [...]
}
```

**D. 批量验证端点**
```bash
curl -X POST http://localhost:3000/api/platforms/batch-validate \
  -H "Content-Type: application/json" \
  -d '{
    "credentials": [
      {"platformId": "devto", "apiKey": "test1"},
      {"platformId": "medium", "apiKey": "test2"}
    ]
  }'
```

---

### 4️⃣ API 端点测试

**获取平台列表 (带缓存)**
```bash
curl http://localhost:3000/api/platforms
```

**获取品牌档案**
```bash
curl http://localhost:3000/api/v2/brand-profile
```

**更新首选平台**
```bash
curl -X PATCH http://localhost:3000/api/v2/brand-profile/preferred-platforms \
  -H "Content-Type: application/json" \
  -d '{"platforms": ["Dev.to", "Medium"]}'
```

**获取首选平台**
```bash
curl http://localhost:3000/api/v2/brand-profile/preferred-platforms
```

---

## 📊 性能基准测试

运行性能基准脚本:

```bash
node scripts/benchmark-optimization.js
```

期望输出:
```
✓ Attempt 1: Load platforms: 125.45ms
✓ Attempt 2: Load platforms: 12.34ms (缓存命中)
✓ Attempt 3: Load platforms: 11.89ms (缓存命中)
✓ 5 concurrent requests: 234.56ms
```

---

## 🔍 网络监控

打开浏览器开发者工具 → Network 标签:

**关键指标**:
- [ ] 平台加载: 首次 ~100-150ms，后续 <20ms
- [ ] API 请求: <500ms
- [ ] 诊断端点: <200ms
- [ ] 健康检查: <50ms

**缓存检查**:
- [ ] XHR 请求数量: 应该减少 60-70%
- [ ] 重复 /api/platforms 请求: 应该减少

---

## 📝 测试数据

### 可用的测试平台

```
Dev.to        (devto)
Medium        (medium)
Hashnode      (hashnode)
GitHub        (github)
Blogger       (blogger)
WordPress     (wordpress)
Telegra.ph    (telegraph)
```

### 测试 API 密钥格式

```
Dev.to:         dpt_test_<random>
Medium:         medium_test_<random>
Hashnode:       hsn_test_<random>
(其他平台类似)
```

---

## 🐛 常见问题排查

**Q1: Onboarding 页面卡在第 2 步**
- A: 检查 API 密钥格式是否正确
- A: 检查网络连接
- A: 查看浏览器控制台的错误信息

**Q2: 平台管理缓存不工作**
- A: 清除浏览器缓存 (Ctrl+Shift+Del)
- A: 检查浏览器是否支持 localStorage
- A: 刷新页面重试

**Q3: 快速添加表单提交失败**
- A: 检查 API 密钥格式
- A: 确保 .env 中的加密密钥配置正确
- A: 查看服务器日志中的错误信息

**Q4: 凭证验证器没有运行**
- A: 正常 - 设计为延迟 10 秒启动，每 24 小时运行一次
- A: 查看服务器日志寻找 "[Credential Validator]" 消息

---

## ✨ 优化验证清单

- [ ] **并发凭证验证**: 3 个同时测试，而不是逐个
- [ ] **请求去重**: onboarding 页面无重复验证请求
- [ ] **平台缓存**: 10 秒内重复请求使用缓存
- [ ] **数据库索引**: 查询响应速度明显
- [ ] **启动时间**: /health 端点立即响应
- [ ] **诊断端点**: GET /api/diagnostics/setup-status 可用
- [ ] **批量验证**: POST /api/platforms/batch-validate 可用
- [ ] **UI 流畅**: Onboarding 和 Admin 页面快速响应
- [ ] **错误处理**: 清晰的错误消息和恢复选项
- [ ] **缓存效率**: 缓存命中率 > 80%

---

## 📚 相关文档

- [优化总结](./OPTIMIZATION_SUMMARY.md) - 详细的优化说明
- [性能基准](./scripts/benchmark-optimization.js) - 自动化基准测试
- [PR #3](https://github.com/redredchen01/content-syndicator/pull/3) - 代码变更

---

## 🛑 停止服务器

```bash
# 找到服务器进程
lsof -i :3000

# 杀死进程
kill -9 <PID>

# 或在启动终端按 Ctrl+C
```

---

## 💡 建议的测试顺序

1. **快速检查** (~5 分钟)
   - [ ] 访问 onboarding.html
   - [ ] 完成 4 步流程
   - [ ] 验证重定向到 admin.html

2. **功能验证** (~10 分钟)
   - [ ] 测试所有平台状态显示
   - [ ] 测试快速添加 API 密钥
   - [ ] 测试诊断端点

3. **性能验证** (~5 分钟)
   - [ ] 运行 benchmark-optimization.js
   - [ ] 检查 Network 标签中的缓存行为
   - [ ] 验证并发请求处理

4. **完整测试** (~15 分钟)
   - [ ] 完整遍历所有功能
   - [ ] 检查错误处理
   - [ ] 验证数据持久化

**总耗时**: 约 35 分钟

---

开始测试！如有任何问题，查看服务器日志或浏览器控制台了解详情。
