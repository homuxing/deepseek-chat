# Deepseek Chat

[English](README.md) | 简体中文

基于 DeepSeek chat-demo，使用 React、Hono、Cloudflare Workers、D1 和 R2。

## 功能

- 邀请码注册、密码登录。
- 管理员密码登录，邀请码和用户管理。
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

前端热更新时另开终端运行 `pnpm dev`，访问 `http://localhost:8090`。管理员登录入口为 `/admin`。

## 部署

`wrangler.jsonc` 已配置 Worker `deepseek-chat`、D1 `chat`（绑定 `DB`）和 R2 `chat`（绑定 `FILES`）。

```sh
pnpm exec wrangler login
pnpm db:migrate:remote
pnpm deploy
```

在 Workers & Pages → deepseek-chat → Settings → Variables and Secrets 配置：

- **Text：** `ADMIN_USERNAME`（3–32 位字母、数字、下划线或短横线，不区分大小写）。
- **可选 Text：** `APP_ORIGIN`（站点地址，如 `https://chat.example.com`）、`DEEPSEEK_API_ORIGIN`（默认 `https://api.deepseek.com`）。
- **Secret：** `ADMIN_PASSWORD`（10–128 个字符）、`DEEPSEEK_API_KEY`、`API_KEY_ENCRYPTION_KEY`（至少 32 个随机字符，妥善备份）。

`keep_vars: true` 会在部署时保留后台文本变量。更换加密 Secret 后，已有自定义 API Key 无法解密。

给 Worker 绑定域名，R2 不开启公共访问。管理员使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录，修改任意一项会使已有管理员会话失效。普通用户不能注册当前管理员用户名。

更新部署前执行 `pnpm db:migrate:remote`。迁移会添加管理员会话校验字段并撤销旧登录方式的管理员会话，保留用户和聊天记录。如曾为站点配置 Cloudflare Access 应用，请将其停用后使用密码登录。

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
