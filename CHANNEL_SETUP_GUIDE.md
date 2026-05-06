# 渠道快速设置指南 (Channel Quick Setup Guide)

## 问题诊断

你的批处理 `batch_17779677` 失败，是因为**未配置足够的发布渠道**。

## 快速修复（3 分钟）

### 第一步：打开诊断面板
访问: http://localhost:3000/admin.html

向下滚动找到 **"🔧 渠道诊断与快速修复"** 部分

### 第二步：查看缺失的渠道
你会看到两个关键信息:
- **已配置渠道**: X 个
- **需要配置**: Y 个

下面列出所有**需要配置的渠道**（红色框）

### 第三步：一键快速配置
有两个选项:

**选项 A: 逐个配置 (推荐)**
1. 点击某个缺失渠道旁的"**配置**"按钮
2. 快速添加表单会出现
3. 输入该平台的 API 密钥
4. 点击"保存密钥"
5. 重复直到所有渠道都已配置

**选项 B: 一键快速修复 (最快)**
1. 点击"**🚀 快速修复（一键配置所有渠道）**"按钮
2. 系统会提示你配置第一个缺失的渠道
3. 逐个配置直到完成

## 常见的失败原因

### 原因 1: API 密钥未配置
**症状**: 所有平台都显示"✗ Missing required API configuration"
**解决**:
```bash
# 检查 .env 文件
cat .env

# 应该包含:
DEVTO_API_KEY=your_key_here
MEDIUM_INTEGRATION_TOKEN=your_key_here
# 等等
```

### 原因 2: 浏览器自动化渠道未配置
**症状**: 某些渠道显示"No saved browser session"
**解决**: 在 onboarding.html 第 3 步配置浏览器自动化，或跳过此步

### 原因 3: 首选平台不匹配
**症状**: 已配置的渠道，但批处理仍然失败
**解决**: 
1. 在 admin.html 查看"**发布平台管理**"部分
2. 检查是否设置了首选平台
3. 验证选中的平台确实已连接

## 可用的发布渠道

### API 渠道 (需要 API 密钥)
| 平台 | 环境变量 | 难度 |
|------|---------|------|
| Dev.to | DEVTO_API_KEY | ⭐ 简单 |
| Medium | MEDIUM_INTEGRATION_TOKEN | ⭐ 简单 |
| Hashnode | HASHNODE_TOKEN | ⭐ 简单 |
| GitHub | GITHUB_TOKEN | ⭐ 简单 |
| Blogger | GOOGLE_APPLICATION_CREDENTIALS_JSON | ⭐⭐ 中等 |
| WordPress | WORDPRESS_SITE_URL + 密码 | ⭐⭐ 中等 |
| Telegra.ph | 自动启用 | ✅ 已启用 |

### 浏览器自动化渠道 (需要浏览器登录)
| 平台 | 支持 | 难度 |
|------|------|------|
| Substack | ✅ | ⭐ 简单 |
| Twitter/X | ✅ | ⭐⭐ 中等 |
| Quora | ✅ | ⭐⭐ 中等 |
| LinkedIn | ✅ | ⭐⭐ 中等 |
| Product Hunt | ✅ | ⭐⭐ 中等 |
| Indie Hackers | ✅ | ⭐ 简单 |

## 获取 API 密钥

### Dev.to
1. 登录 https://dev.to
2. 设置 → API Keys
3. 复制 API Key
4. 粘贴到 admin.html 的快速添加表单

### Medium
1. 登录 https://medium.com
2. 设置 → 开发者设置
3. 创建新的 Integration Token
4. 复制并粘贴

### Hashnode
1. 登录 https://hashnode.com
2. 设置 → API Keys
3. 创建新 Token
4. 复制并粘贴

### GitHub
1. 登录 https://github.com
2. 设置 → 开发者设置 → Personal access tokens
3. 创建 Token (需要 `public_repo` 权限)
4. 复制并粘贴

### WordPress
1. 使用 WordPress 站点 URL
2. 使用应用密码 (而非实际密码)
3. 创建应用密码：设置 → 安全
4. 粘贴用户名和应用密码

## 验证配置

### 方法 1: Admin 面板检查
访问 admin.html，查看**发布平台管理**部分:
- ✅ 绿色 = 连接成功
- ❌ 红色 = 配置失败

### 方法 2: API 检查
```bash
# 查看所有平台状态
curl http://localhost:3000/api/platforms | jq '.platforms[] | {name, connected}'

# 检查特定批处理失败原因
curl http://localhost:3000/api/batch-status/batch_17779677 | jq
```

### 方法 3: 查看最近失败
在 Admin 面板的**❌ 最近失败的批处理**部分:
- 点击任何失败批处理查看详细错误
- 分析哪些渠道失败及为什么

## 重新运行失败的批处理

一旦配置完所有渠道:

1. 使用同样的内容和平台选择重新运行发布
2. 系统会自动使用新配置的渠道
3. 检查新批处理的状态

## 进阶: 自定义首选平台

如果你想让某些批处理使用特定的渠道组合:

### 通过 API 设置首选平台
```bash
curl -X PATCH http://localhost:3000/api/v2/brand-profile/preferred-platforms \
  -H "Content-Type: application/json" \
  -d '{"platforms": ["Dev.to", "Medium", "Hashnode"]}'
```

### 验证设置
```bash
curl http://localhost:3000/api/v2/brand-profile/preferred-platforms | jq
```

## 故障排除

### Q: 配置后仍显示"未连接"
A: 
1. 检查 API 密钥是否正确
2. 等待 10 秒，系统会自动验证
3. 刷新页面

### Q: 某个渠道一直失败
A:
1. 检查 API 密钥是否过期
2. 验证密钥有正确的权限范围
3. 检查网络连接
4. 查看详细错误信息

### Q: batch_17779677 还是失败
A: 这个旧批处理记录已失败，需要:
1. 创建新的发布请求
2. 使用最新配置的渠道
3. 查看新批处理的状态

### Q: 如何知道我配置了多少个渠道?
A: 
1. Admin 面板顶部显示"**已配置渠道: X**"
2. API 端点 `/api/platforms` 显示所有渠道状态
3. 绿色指示器 = 已配置，红色 = 未配置

## 最佳实践

1. **从简单的开始** 
   - 先配置 Dev.to 和 Telegra.ph (已自动启用)
   - 然后添加 Medium 和 Hashnode

2. **测试配置**
   - 配置后立即在 admin.html 验证
   - 发送一个测试批处理

3. **定期检查**
   - 每周检查一次平台连接状态
   - API 密钥可能过期

4. **使用首选平台**
   - 配置 3-5 个可靠的渠道作为首选
   - 这样每次发布都会使用这些渠道

## 联系支持

如果配置完所有步骤后仍然有问题:

1. 查看服务器日志: `tail -100 /tmp/server.log`
2. 检查浏览器控制台错误
3. 验证所有渠道的 API 密钥
4. 尝试重启服务器

---

**总结**: 大多数批处理失败是因为渠道配置不足。使用 admin.html 的诊断面板快速识别缺失的渠道，使用快速配置功能添加它们。配置完成后，新的批处理应该会成功。

---

## Medium & Blogger — OAuth / 浏览器登录配置（推荐路径）

Medium 与 Blogger 现在统一支持「点按钮 → 浏览器登录 → 自动连接」的 UX。底层走两条不同的技术路径，因为两个平台的认证现实不同：

| 平台 | 状态 | 推荐做法 |
|---|---|---|
| **Medium** | API token 自 2023 起停止发新（旧 token 仍可用） | 留空 `MEDIUM_INTEGRATION_TOKEN` → admin 页点 Medium 卡片的「使用浏览器登录」 |
| **Blogger** | Google OAuth 2.0 完整可用 | 一次性配置 Google Cloud OAuth Client → admin 页点「Connect with Google」 |

### Blogger 配置步骤（5 分钟）

1. 进 [Google Cloud Console](https://console.cloud.google.com/)，创建一个新项目（或选已有项目）
2. **APIs & Services** → **Library** → 搜索「Blogger API v3」→ 点 Enable
3. **APIs & Services** → **OAuth consent screen**
   - User Type 选 **External** → Create
   - App name / User support email / Developer contact 填好
   - Scopes 步骤先跳过（直接 Save and Continue）
   - **Test users**：添加你自己的 Gmail（开发阶段必须，生产时可申请 verification）
4. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
   - Application type 选 **Web application**
   - Authorized redirect URIs 添加：`http://localhost:3000/api/auth/google/callback`
     （生产环境换成你的公网域名 + 同一路径，逗号分隔可多填）
   - Create → 得到 Client ID 和 Client Secret
5. 复制到 `.env`：
   ```
   GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxx
   OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
   BLOGGER_BLOG_ID=1234567890123456789
   ```
   （`BLOGGER_BLOG_ID` 在你的 Blogger 后台 URL 里：`blogger.com/blog/posts/<这串数字>`）
6. 重启服务器：`npm start`
7. 打开 admin.html，Blogger 卡片显示蓝色「Connect with Google」按钮 → 点击 → Google 同意页 → 点 Allow → 自动回到 admin.html，看到 `✅ 已成功连接 blogger` toast

### Medium 浏览器登录（无需 Google Cloud 配置）

1. 在 `.env` 设 `ENABLE_BROWSER_AUTOMATION=true`，留空 `MEDIUM_INTEGRATION_TOKEN`
2. 重启服务器
3. admin.html → Medium 卡片下方点「或使用浏览器登录」链接
4. 系统打开有头浏览器到 medium.com 登录页 → 你手动登录 → 关闭窗口
5. UI 自动检测到 session（cookie 数 ≥ 5），badge 变绿「✅ 已连接」

### 故障排查

**「OAuth 失败：redirect_uri_mismatch」**
- Google Cloud Console 里配置的 redirect URI 必须**完全匹配** `.env` 的 `OAUTH_REDIRECT_URI`（包括 http vs https、端口号、尾部斜杠）

**「OAuth 失败：Google did not return a refresh_token」**
- 上次授权过、Google 没重发 refresh_token。去 [Google 帐户授权页](https://myaccount.google.com/permissions) 撤销本应用 → admin.html 重新点 Connect

**「Connect with Google 按钮灰化」**
- 缺少 `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `OAUTH_REDIRECT_URI` 任一环境变量

**「Blogger 发布报 invalid_grant」**
- refresh_token 被 Google 撤销（用户主动撤销 / 90 天未使用 / 密码改了）
- 系统已自动清理失效 token；点 Connect with Google 重新授权即可

**部署到生产时的注意事项**
- `OAUTH_REDIRECT_URI` 改成你的公网域名 + `/api/auth/google/callback`
- Google Cloud Console 的 Authorized redirect URIs 同步加上这个 URL
- 备份 `ENCRYPTION_KEY`：丢失会导致所有已存的 refresh_token 无法解密
