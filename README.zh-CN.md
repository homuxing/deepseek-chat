# 私有 DeepSeek Chat

[English](README.md) | 简体中文

基于 DeepSeek 官方 chat-demo 改造，React 前端与 Hono 后端部署在同一个 Cloudflare Worker。D1 保存用户、邀请码、登录会话和聊天记录，私有 R2 Bucket 保存附件原件。

## 功能

- 用户通过用户名、密码和邀请码注册，使用密码登录；登录状态存于 HttpOnly Cookie。
- 管理员通过 Cloudflare Access 登录，后端验证 JWT 签名、issuer、audience、有效期及邮箱白名单。
- 管理员创建/删除邀请码，设置有效期与使用次数；邀请码仅创建时返回原文。
- 用户管理包括启用/停用、重置普通用户密码、删除用户、清空指定用户记录。停用和改密撤销会话，管理员清空记录也撤销目标登录会话。
- 聊天与附件按用户隔离。即使共享部署 API Key，上游文件 ID 也检查当前用户归属。
- 聊天、附件、ASR、TTS 通过 Worker 代理，保留 SSE 和音频流。
- 数据管理可保存、替换、清除自定义 API Key。优先使用用户 Key，否则使用环境变量 DEEPSEEK_API_KEY。自定义 Key 经 AES-GCM 加密写入 D1，浏览器只获得是否配置的状态。
- 保留消息分支、Markdown、深度思考、搜索、主题和历史 ZIP 导入导出。

## 本地运行

准备 Node.js 24 与 pnpm，在项目目录执行：

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm build
pnpm db:migrate:local
pnpm dev:worker
```

Windows PowerShell 使用 `Copy-Item .dev.vars.example .dev.vars`。填写 `.dev.vars` 中的 API Key 与至少 32 个随机字符的加密 Secret。访问 `http://localhost:8787`。

前端开发时另一个终端运行 `pnpm dev`，访问 `http://localhost:8090`，Rspack 会把 `/api` 代理到本地 Worker 的 8787 端口。

本地管理员也需要真实 Access 身份：通过 Cloudflare Tunnel 将本地服务绑定到配置了 Access 的测试域名，设置团队域名、AUD 和管理员邮箱。项目没有管理员鉴权旁路；自动化测试使用隔离测试数据库和签名测试 JWT。

## Cloudflare 部署

创建资源：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create private-chat
pnpm exec wrangler r2 bucket create private-chat-files
```

把返回的 D1 `database_id` 写入 `wrangler.jsonc`，核对 R2 名称，并给 Worker 绑定域名，例如 `chat.example.com`。

在 Cloudflare Zero Trust 创建 Self-hosted Access Application：

1. 保护 `chat.example.com/api/admin/access*`，包括入口和 callback。
2. Allow 策略仅允许你的管理员邮箱。普通用户首页、`/api/auth/*` 和其余 API 不要被该 Access Application 保护。
3. 把团队域名（如 `your-team.cloudflareaccess.com`）与 Application 的 AUD Tag 写入 `CF_ACCESS_TEAM_DOMAIN` 和 `CF_ACCESS_AUD`。
4. `ADMIN_EMAILS` 填管理员邮箱，多个邮箱以英文逗号分隔。后端独立检查此白名单。
5. 建议配置 `APP_ORIGIN=https://chat.example.com`，统一用此主域名访问。

写入 Worker Secrets、应用迁移并部署：

```sh
pnpm exec wrangler secret put DEEPSEEK_API_KEY
pnpm exec wrangler secret put API_KEY_ENCRYPTION_KEY
pnpm db:migrate:remote
pnpm deploy
```

可以生成加密 Secret，然后通过交互输入保存：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

妥善保存 `API_KEY_ENCRYPTION_KEY`。直接替换后，已有自定义 Key 无法解密，用户需清除后重新填写。R2 保持私有，不开启公开 Bucket URL。Assets binding 提供前端，所有 `/api/*` 请求先进入 Hono。

部署后点击“管理员登录”，通过 Access 验证。入口换取两分钟、一次性的服务器登录凭据，callback 用 POST 换取应用会话。然后打开“设置 → 通用设置 → 管理”，创建并复制邀请码给朋友。他们在注册页输入用户名、密码和邀请码即可使用。

## 数据和限制

聊天和原件保存于服务端，同一账户可跨设备加载历史。浏览器只保存语言、主题等偏好。旧版本 IndexedDB 历史不自动迁移，可先在旧版导出 ZIP，再导入当前实例。

历史导入先校验 ZIP、使用新文件 ID 上传原件，最后用 D1 batch 原子替换会话。单次导入最多 200 个会话，请求 JSON 不超过 1 MiB，单会话 JSON 不超过 900 KiB。导入失败不覆盖旧原件；失败上传留下的未引用文件在下次成功导入或清空记录时清理。格式详见 [历史导入导出](src/services/chat/history/README.md)。

删除单个会话清理不再被其他会话引用的 R2 原件。清空记录清理用户的 D1 聊天、R2 原件和上游文件关联。已上传到 DeepSeek 的文件不自动调用远端删除接口，因为会话和分支可能复用文件。

发送消息、附件和语音时内容仍提交给 DeepSeek；私有部署指应用与历史存储由你控制。聊天模型保留 `deepseek-flash`，API 依赖原项目的 Anthropic Messages/Files 与 ASR/TTS 扩展。

登录、注册、聊天、上传和语音具有持久化限流；每天的 Worker Cron 清理过期会话、管理员登录凭据和限流数据。D1 与 R2 没有跨资源事务，原件清理失败可能留下未引用文件，后续清理可重试。

## 验证

```sh
pnpm type
pnpm lint
pnpm test
pnpm build
pnpm exec wrangler deploy --dry-run
```

测试用真实 SQLite 验证 SQL、邀请核销与事务回滚，隔离 R2 测试附件归属，用签名 JWT 验证 Access 边界。dry-run 只打包，不部署。GitHub Actions 仅运行 CI，不再发布 GitHub Pages；云端部署需要你自己的资源与 Secrets。

## 许可证

[MIT](LICENSE)。分发时保留 `dist/LICENSE`，第三方依赖遵循各自许可证。
