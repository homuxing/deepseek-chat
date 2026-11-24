# Deepseek Chat

[English](README.md) | 简体中文

基于 DeepSeek chat-demo，使用 React、Hono、Cloudflare Workers、D1 和 R2。

## 功能

- 邀请码注册、密码登录。
- 管理员密码登录，邀请码和用户管理。
- 按用户在云端保存聊天记录和附件，支持官方 DeepSeek ZIP 导入导出与多设备自动同步。
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

`wrangler.jsonc` 已配置 Worker `deepseek-chat`、D1 `chat`（绑定 `DB`）、私有 R2 `chat`（绑定 `FILES`）和 Durable Object `HistorySync`（绑定 `SYNC`）。D1 保存会话目录与版本，R2 保存完整会话 JSON 和附件原件。

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

云端历史依赖 `migrations/0004_cloud_history.sql`。该迁移保留现有用户与会话，添加目录代次、会话版本、R2 正文引用、附件引用，以及导入和 multipart upload 状态记录。现有 D1 会话正文仍可读取，后续写入使用 R2。本地执行 `pnpm db:migrate:local`；`pnpm deploy` 和 `pnpm deploy:worker` 会在发布前应用远程迁移。应应用全部迁移，避免环境之间出现表结构差异。

保留 `wrangler.jsonc` 中的 `SYNC` Durable Object 绑定，以及 `history-sync-v1` 迁移的 `new_sqlite_classes: ["HistorySync"]`。Wrangler 发布导出 `HistorySync` 类的 Worker 时会同时应用该 DO 迁移。D1 迁移和 DO 部署均需完成，云端历史与多设备自动通知依赖这些配置。

在 Workers & Pages → deepseek-chat → Settings → Variables and Secrets 配置：

- **Text 或 Secret：** `ADMIN_USERNAME`（3–32 位字母、数字、下划线或短横线，不区分大小写）。在 Worker 运行时配置中填写管理员用户名。
- **可选 Text：** `APP_ORIGIN`（站点地址，如 `https://chat.example.com`）、`DEEPSEEK_API_ORIGIN`（默认 `https://api.deepseek.com`）。
- **Secret：** `ADMIN_PASSWORD`（10–128 个字符）、`DEEPSEEK_API_KEY`、`API_KEY_ENCRYPTION_KEY`（至少 32 个随机字符，妥善备份）。

`keep_vars: true` 会在部署时保留后台文本变量。更换加密 Secret 后，已有自定义 API Key 无法解密。

`API_KEY_ENCRYPTION_KEY` 用于加密自定义 API Key，至少包含 32 个随机字符，邀请码功能无需配置它。可以使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成密钥，妥善备份后执行 `pnpm secret:put API_KEY_ENCRYPTION_KEY --config wrangler.jsonc` 设置。仅在构建环境配置同名变量无法满足自定义 API Key 的运行时要求。

给 Worker 绑定域名，R2 不开启公共访问。管理员使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录，修改任意一项会使已有管理员会话失效。普通用户不能注册当前管理员用户名。

部署命令会自动执行 `pnpm db:migrate:remote`。管理员密码登录的迁移会添加会话校验字段并撤销旧登录方式的管理员会话，保留用户和聊天记录。如曾为站点配置 Cloudflare Access 应用，请将其停用后使用密码登录。

管理员登录后，打开“设置 → 通用设置 → 管理”创建邀请码和管理用户。

邀请码随机生成后以原字符串保存，管理员可在列表中查看和复制；注册通过哈希校验邀请码及其使用次数和有效期，邀请码不依赖加密密钥。仅保存哈希的历史记录无法恢复原码，已分发的原码仍可注册。

`0006_plain_invite_codes.sql` 添加原码列并保留全部现有记录。数据库迁移命令自动转换已保存的邀请码密文，部署后再处理发布期间产生的密文。转换已有密文需要原 `API_KEY_ENCRYPTION_KEY`，远程迁移从 `.env.production.encryption` 或命令环境读取，本地迁移从 `.dev.vars` 或命令环境读取；也可执行 `node scripts/migrate-invite-codes.mjs --remote --key-file <密钥文件>` 指定包含该变量的文件。密钥不正确或记录损坏会停止转换并保留原数据。转换完成后，邀请码生成、读取和注册均无需该密钥。

普通用户登录有效期为 7 天，剩余不超过 1 天时，成功的站内请求会自动续期至 7 天后；首次登录后最多保持 30 天。管理员登录有效期为 1 天，剩余不超过 6 小时时自动续期，首次登录后最多保持 7 天。达到期限后需要重新登录；持续 7 天未访问的普通用户、持续 1 天未访问的管理员也需要重新登录。

密码重置、账户状态修改和管理员清空用户聊天会撤销该用户的登录会话。会话创建与续期均检查凭据版本，正在进行的旧凭据登录无法绕过撤销。`0003_session_renewal.sql` 迁移会撤销现有登录会话，保留用户和聊天记录，迁移后需要重新登录一次。

## 检查

```sh
pnpm type
pnpm lint
pnpm build
pnpm test
pnpm deploy:dry-run
```

GitHub Actions 在推送、PR 或手动触发时执行这些检查。生产自动部署由 Cloudflare Workers 的 Git 集成执行，使用上面的构建和部署命令。

## 历史记录

支持导入 `export_format_version: 3` 的官方 DeepSeek 历史 ZIP。浏览器读取 ZIP 目录，统计对话数和去重后的附件数，再逐条解析并上传对象；ZIP 本身不会上传给后端。小会话按最多 16 个且不超过 256 KiB 组成一批，通过 `POST /chats/imports/:id/chats` 保存；不超过 8 MiB 的附件使用直接 `PUT`，更大的对象继续使用 multipart upload。共享原件会核对其所有引用位置，只上传一次；会话批次与附件共用最多四个并发任务。阻断操作的进度蒙层展示真实的已完成数量和全部数量。保留完整消息树、当前分支、正文、思考、搜索结果和置顶属性；图片、文档及其他可取得的附件原件保存至 R2，共享附件在多个会话中保持统一文件标识。缺失原件保留元信息，支持 ZIP32 和 ZIP64。ZIP 解析在浏览器内完成，导入流程不依赖高额 `cpu_ms` 配置。实际容量仍受浏览器、Worker 和 Cloudflare 平台限制约束。

D1 保存当前用户的会话目录、版本与附件引用，R2 保存完整会话 JSON 和原件。全部对象保存并完成归档校验后，才原子切换历史。失败时停止新增任务，等待在途上传结束后清理暂存内容；账号和版本检查会阻止导入覆盖其他设备的新历史。使用同一账号的设备通过 Durable Object 通知自动读取最新历史，重新连接和返回页面时也会同步，无需固定轮询或手动刷新。详见[历史格式与云端部署](src/services/chat/history/README.md)。

## 许可证

[MIT](LICENSE)。分发时保留 `dist/LICENSE`。
