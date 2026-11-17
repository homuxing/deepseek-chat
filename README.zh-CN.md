# Deepseek Chat

[English](README.md) | 简体中文

基于 DeepSeek chat-demo，使用 React、Hono、Cloudflare Workers、D1 和 R2。

## 功能

- 邀请码注册、密码登录。
- Cloudflare Access 管理员登录，邀请码和用户管理。
- 按用户保存聊天记录和附件，支持 ZIP 导入导出。
- 自定义 API Key 加密保存，未设置时使用 `DEEPSEEK_API_KEY`。
- 流式聊天、深度思考、搜索和语音。

## 本地运行

准备 Node.js 24 和 pnpm：

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm build
pnpm db:migrate:local
pnpm dev:worker
```

填写 `.dev.vars`，访问 `http://localhost:8787`。PowerShell 使用 `Copy-Item .dev.vars.example .dev.vars`。

前端热更新时另开终端运行 `pnpm dev`，访问 `http://localhost:8090`。本地管理员登录需要受 Access 保护的域名，可通过 Cloudflare Tunnel 配置。

## 部署

`wrangler.jsonc` 已配置 Worker `deepseek-chat`、D1 `chat`（绑定 `DB`）和 R2 `chat`（绑定 `FILES`）。

```sh
pnpm exec wrangler login
pnpm db:migrate:remote
pnpm deploy
```

在 Workers & Pages → deepseek-chat → Settings → Variables and Secrets 配置：

- **Text：** `CF_ACCESS_TEAM_DOMAIN`（如 `your-team.cloudflareaccess.com`）、`CF_ACCESS_AUD`（管理员应用的 AUD Tag）、`ADMIN_EMAILS`（多个邮箱用英文逗号分隔）。
- **可选 Text：** `APP_ORIGIN`（站点地址，如 `https://chat.example.com`）、`DEEPSEEK_API_ORIGIN`（默认 `https://api.deepseek.com`）。
- **Secret：** `DEEPSEEK_API_KEY`、`API_KEY_ENCRYPTION_KEY`（至少 32 个随机字符，妥善备份）。

`keep_vars: true` 会在部署时保留后台文本变量。更换加密 Secret 后，已有自定义 API Key 无法解密。

给 Worker 绑定域名，在 Cloudflare Zero Trust 创建 Self-hosted Access 应用，保护 `chat.example.com/api/admin/access*`，Allow 策略允许管理员邮箱；其余应用路径不纳入此策略。R2 不开启公共访问。

管理员登录后，打开“设置 → 通用设置 → 管理”创建邀请码和管理用户。

## 检查

```sh
pnpm type
pnpm lint
pnpm test
pnpm build
pnpm exec wrangler deploy --dry-run
```

GitHub Actions 在推送、PR 或手动触发时执行这些检查，不自动部署。

## 历史记录

旧版记录可导出 ZIP 后导入。单次导入最多 200 个会话、1 MiB JSON，单会话最多 900 KiB。详见[历史格式](src/services/chat/history/README.md)。

## 许可证

[MIT](LICENSE)。分发时保留 `dist/LICENSE`。
