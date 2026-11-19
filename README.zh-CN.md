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

使用 **Cloudflare Workers** 部署。`pnpm build` 生成 `dist` 前端资源，Wrangler 根据 `main: server/index.ts` 打包后端，并将前后端一起发布。Pages 的 `pnpm build` + `dist` 配置只会发布当前项目的前端，不能运行登录接口。

### Git 自动部署

在 Cloudflare 的 Workers & Pages 中创建 **Worker**，连接 `homuxing/deepseek-chat` 仓库，使用以下设置：

- Worker 名称：`deepseek-chat`，与 `wrangler.jsonc` 保持一致。
- 生产分支：`main`，启用自动部署。
- 根目录：仓库根目录（留空）。
- 构建命令：`pnpm build`。
- 部署命令：`pnpm deploy:worker`。
- 构建环境：Node.js 24，pnpm 版本由 `package.json` 中的 `packageManager: pnpm@11.5.1` 固定，GitHub Actions 使用同一版本。如需覆盖 Node.js 自动检测版本，设置构建变量 `NODE_VERSION=24`。

推送到 `main` 后，Cloudflare 构建前端，再执行 `deploy:worker`：先应用尚未执行的远程 D1 迁移，成功后发布 Worker 后端及 `dist` 前端资源。迁移失败时停止发布。构建使用的 Cloudflare API Token 需要该账户的 Workers Scripts、D1 和 R2 权限，其中 D1 需要 Edit 权限才能执行迁移。

确认配置中的 D1 数据库 ID 和 R2 桶属于该 Cloudflare 账户；可以复用已有 `chat` 数据库和桶。在新 Worker 的 **运行时** Variables and Secrets 中填写下列配置，Pages 项目的变量不会自动迁移，构建变量也不会提供给运行时。

首次部署后，使用 Worker 默认地址检查：页面应正常打开，未登录请求 `/api/auth/me` 应返回 `401`、`application/json` 和登录提示。随后从旧 Pages 项目移除 `chat.homu.space` 的自定义域名绑定，并在 Worker 的 Domains & Routes 中添加该域名。若配置 `APP_ORIGIN`，设置为 `https://chat.homu.space` 后再使用正式域名登录。确认正式域名可用后，可以删除旧 Pages 项目。

### 本地终端部署

```sh
pnpm exec wrangler login
pnpm deploy
```

`pnpm deploy` 构建前端、应用远程 D1 迁移，然后将前后端一起发布。

在 Workers & Pages → deepseek-chat → Settings → Variables and Secrets 配置：

- **Text：** `ADMIN_USERNAME` 已在 `wrangler.jsonc` 的 `vars` 中设置为 `Admin`。修改用户名时更新该配置并推送（3–32 位字母、数字、下划线或短横线，不区分大小写）。
- **可选 Text：** `APP_ORIGIN`（站点地址，如 `https://chat.example.com`）、`DEEPSEEK_API_ORIGIN`（默认 `https://api.deepseek.com`）。
- **Secret：** `ADMIN_PASSWORD`（10–128 个字符）、`DEEPSEEK_API_KEY`、`API_KEY_ENCRYPTION_KEY`（至少 32 个随机字符，妥善备份）。

`keep_vars: true` 会在部署时保留后台文本变量。更换加密 Secret 后，已有自定义 API Key 无法解密。

给 Worker 绑定域名，R2 不开启公共访问。管理员使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录，修改任意一项会使已有管理员会话失效。普通用户不能注册当前管理员用户名。

部署命令会自动执行 `pnpm db:migrate:remote`。管理员密码登录的迁移会添加会话校验字段并撤销旧登录方式的管理员会话，保留用户和聊天记录。如曾为站点配置 Cloudflare Access 应用，请将其停用后使用密码登录。

管理员登录后，打开“设置 → 通用设置 → 管理”创建邀请码和管理用户。

## 检查

```sh
pnpm type
pnpm lint
pnpm test
pnpm build
pnpm deploy:dry-run
```

GitHub Actions 在推送、PR 或手动触发时执行这些检查。生产自动部署由 Cloudflare Workers 的 Git 集成执行，使用上面的构建和部署命令。

## 历史记录

旧版记录可导出 ZIP 后导入。单次导入最多 200 个会话、1 MiB JSON，单会话最多 900 KiB。详见[历史格式](src/services/chat/history/README.md)。

## 许可证

[MIT](LICENSE)。分发时保留 `dist/LICENSE`。
