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

### 生产部署的安全 hardening

**ENCRYPTION_KEY 必须设置**（生产模式下不设会拒绝启动）：
```bash
openssl rand -hex 32  # 复制结果到 .env 的 ENCRYPTION_KEY
```
切记备份这把密钥 — 丢失会导致所有已加密的 API key 和 OAuth refresh_token 不可恢复。

**ENCRYPTION_KEY 旋转**：换新密钥后，旧的 oauth_tokens.refresh_token 行无法解密。系统会自动检测并清理失败的行（admin 页 Blogger 卡片会变回未连接），用户重新点 Connect with Google 即可。但加密的 api_keys_encrypted 没有同样的自动清理 — 旋转前请在 admin 页面重新填写 API key 表单。

**OAuth 端点访问限制**：默认只允许 loopback (`127.0.0.1`) 访问 `/api/auth/google/start` 和 `DELETE /api/auth/oauth/:platform`，防止任何能访问到 server 端口的网络对手断开你的 OAuth 连接或刷爆 Google client_id 配额。

部署到公网时（反向代理 + 自己的 auth 层），设置：
```
OAUTH_ALLOW_REMOTE=true
```
**前提是**：你的反向代理必须对所有 admin/auth 路径强制鉴权（basic auth、JWT、SSO 等）。否则相当于把这些端点直接暴露给公网。

---

## Twitter / X — OAuth 2.0 PKCE 配置（推荐）

新接入推荐走 OAuth 2.0 PKCE，admin.html 一键 Connect with X。OAuth 1.0a（4 个 keys）保留作为 fallback，存量用户零迁移。

### 5 分钟操作步骤

1. 进 [X Developer Portal](https://developer.x.com/en/portal/dashboard)
2. **Create Project** → 起个名字，选 use case → Create App
3. App 设置页 → 找 **User authentication settings** → 点 **Set up**
   - **App permissions**：选 **Read and write**（仅 Read 不能发推）
   - **Type of App**：选 **Web App, Automated App or Bot**
   - **Callback URI / Redirect URL**：填 `http://localhost:3000/api/auth/twitter/callback`
   - **Website URL**：随便填一个真实 URL（X 要求非空，不会真访问）
   - 保存
4. 跳到 **Keys and Tokens** 页 → **OAuth 2.0 Client ID and Client Secret** 段
5. **Generate** → 拷贝 Client ID 和 Client Secret 到 `.env`：
   ```
   TWITTER_OAUTH_CLIENT_ID=...
   TWITTER_OAUTH_CLIENT_SECRET=...
   TWITTER_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/twitter/callback
   ```
6. 重启 server：`npm start`
7. admin.html → Twitter 卡片显示蓝色 **「Connect with X」** → 点击 → X 同意页 → Allow → 自动回到 admin

### 关键约束

- **Callback URI 必须完全匹配** — 任何 `http://` vs `https://`、端口号、尾斜杠差异都会被 X 拒绝
- **scope `offline.access` 是必需的** — 没有这个 scope，X 不会返回 `refresh_token`，token 一过期（2 小时）就废
- **App permissions 必须是 Read and write** — Read-only 拿到 token 也无法发推
- **Free tier 月限额** — X 的免费 tier 每月发推数量有限，超了 OAuth 2.0 token 一样不能用（但 token 仍然有效，限额重置后自动恢复）

### 故障排查

**「invalid_client」错误**
- Client ID 或 Secret 拷错了 / 多了空格

**「Redirect URI not registered」**
- X Developer Portal 的 Callback URI 设置必须和 `.env` 的 `TWITTER_OAUTH_REDIRECT_URI` 完全一致

**「Twitter did not return a refresh_token」**
- App permissions 不是 Read and write，或者 scope 设置错了
- 解决：在 X Developer Portal 调整权限，然后用户重新授权

**OAuth 2.0 路径连不通，但有旧的 OAuth 1.0a keys**
- 不删 `TWITTER_CONSUMER_KEY` 等环境变量，TwitterAdapter 会自动 fallback 到 OAuth 1.0a 路径
- 旧 4-key 用户零迁移

---

## WordPress.com — OAuth 2.0 配置（推荐）

WordPress.com 用户走 OAuth 一键连接；self-hosted 用户继续用 Application Password，无需迁移。Adapter 三级回退：OAuth → Application Password → 错误。

### 5 分钟操作步骤

1. 登录 [WordPress.com Apps](https://developer.wordpress.com/apps/) → **Create New Application**
2. 填写：
   - **Name**：你的应用名（任意）
   - **Description**：可选
   - **Website URL**：可填项目 URL 或本机 URL
   - **Redirect URLs**：`http://localhost:3000/api/auth/wordpress/callback`（本地开发）
   - **Type**：Web
3. 保存 → 拷贝 **Client ID** 和 **Client Secret** 到 `.env`：
   ```
   WORDPRESS_OAUTH_CLIENT_ID=...
   WORDPRESS_OAUTH_CLIENT_SECRET=...
   WORDPRESS_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/wordpress/callback
   ```
4. 重启 server → admin.html 上 WordPress 卡片显示「Connect with WordPress.com」
5. 点击 → WordPress.com 同意页 → 选要授权的博客（OAuth 后默认用 primary site_id）→ Approve → 回到 admin 显示 ✅ 已连接

### 关键约束

- **Redirect URL 必须完全匹配** — 任何 scheme / port / 尾斜杠差异都会被 WordPress.com 拒绝
- **WordPress.com OAuth 不返回 refresh_token** — access_token 长期有效（除非用户在 [Connected Applications](https://wordpress.com/me/security/connected-applications) 撤销）。Adapter 内部用 sentinel 模式落库，无需手动 refresh
- **OAuth 后默认用 primary blog** — 用户首次 OAuth 时同意页会让选博客；首版采用 token 响应中的 `blog_id`，多博客切换 UI 留 P3
- **OAuth 优先于 Application Password** — 同时配置时 adapter 走 OAuth 路径；想强制走 self-hosted 时在 admin 页点 **断开** 清除 OAuth 行

### 故障排查

**「Connect with WordPress.com」按钮灰化**
- 三个 env 变量没配齐（Client ID / Secret / Redirect URI）
- 重启 server 才能让 `isConfigured()` 重新评估

**「authorization_required」/ 401 错误**
- access_token 已被用户撤销（或服务端策略主动清除）
- adapter 自动清理 oauth_tokens.wordpress 行 → admin 页提示「请重新连接」

**publish 后回 404 / blog not found**
- `blog_id` 已失效（用户在 WordPress.com 删除了 site）
- 在 admin 页点 **断开** → 重新 Connect → 选择新 site

---

## GitHub — OAuth 2.0 配置（推荐 Gist 发布）

新接入用户走 OAuth；存量 `GITHUB_TOKEN` PAT 用户零迁移（adapter 优先 OAuth，其次 PAT）。

### 5 分钟操作步骤

1. 登录 GitHub → [Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) → **New OAuth App**
2. 填写：
   - **Application name**：你的应用名（任意）
   - **Homepage URL**：项目 URL 或 `http://localhost:3000`
   - **Authorization callback URL**：`http://localhost:3000/api/auth/github/callback`
3. **Register application** → 详情页点 **Generate a new client secret** → 拷贝
4. 把 Client ID + Secret 写入 `.env`：
   ```
   GITHUB_OAUTH_CLIENT_ID=...
   GITHUB_OAUTH_CLIENT_SECRET=...
   GITHUB_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/github/callback
   ```
5. 重启 server → admin.html → GitHub 卡片显示「Connect with GitHub」
6. 点击 → GitHub 同意页（仅请求 `gist` scope）→ Authorize → 回到 admin ✅

### 关键约束

- **scope 仅请求 `gist`** — Gist 发布的最小权限。后续若改用 repo PR 发布需加 `repo` scope（更高侵入性，需用户重新授权）
- **不返回 refresh_token** — 同 WordPress.com，access_token 长期有效，sentinel 模式落库
- **用户在同意页可勾掉 scope** — adapter 在 callback 时验证返回的 `scope` 含 `gist`，否则报 `oauth_error=insufficient_scope`，admin 提示「权限不足，请重新授权并勾选 gist」
- **OAuth 优先于 PAT** — 已配 `GITHUB_TOKEN` 的用户在 OAuth 后会自动切到 OAuth 路径；想回退到 PAT 在 admin 页点 **断开**

### 故障排查

**「insufficient_scope」错误**
- 同意页上用户取消了 gist 权限勾选
- 解决：admin 页点 **重新授权** → 同意页确保 gist 勾上

**「Bad credentials」/ 401**
- 用户在 [Authorized OAuth Apps](https://github.com/settings/applications) 撤销了 app 授权
- adapter 自动清理 oauth_tokens.github 行 → admin 页提示「请重新连接」
- 若 `GITHUB_TOKEN` env 仍配置，下次 publish 自动 fallback 到 PAT 路径（无需重启）

**「No OAuth App access available」**
- GitHub 组织开启了 [OAuth App access restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data) 但未授权此 app
- 在组织设置中批准 app 后用户重新授权

---

## Tier 1 平台（Dev.to / Hashnode）— PAT 一键生成

Dev.to / Hashnode 没有公开 OAuth API，仅支持 Personal Access Token (PAT)。admin.html 在每个卡片旁提供「**获取 API Key ↗**」link，新窗口直跳生成页：

| 平台 | 生成页 |
|------|------|
| Dev.to | [https://dev.to/settings/extensions](https://dev.to/settings/extensions) |
| Hashnode | [https://hashnode.com/settings/developer](https://hashnode.com/settings/developer) |

操作流程：
1. admin.html 平台卡片 → 点「获取 API Key ↗」→ 新窗口打开
2. 在生成页按平台提示创建 token
3. 复制 token → 回到 admin.html → 点「连接」按钮 → 在弹出的表单中粘贴 → 保存

API key 表单内会显示 inline 链接「点此打开生成页 ↗」作为二次入口，避免用户在跳转中迷路。
