# Deepseek Chat

English | [简体中文](README.zh-CN.md)

Based on DeepSeek's chat demo, with React, Hono, Cloudflare Workers, D1 and R2.

## Features

- Invitation registration and password login.
- Cloudflare Access administrator login, invitation and user management.
- Per-user chat history and attachments, with ZIP import and export.
- Encrypted custom API keys, with `DEEPSEEK_API_KEY` as the fallback.
- Streaming chat, reasoning, search and speech.

## Development

Use Node.js 24 and pnpm:

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm build
pnpm db:migrate:local
pnpm dev:worker
```

Fill in `.dev.vars` and open `http://localhost:8787`. In PowerShell, use `Copy-Item .dev.vars.example .dev.vars`.

For frontend hot reload, also run `pnpm dev` and open `http://localhost:8090`. Local administrator login requires an Access-protected hostname, for example through Cloudflare Tunnel.

## Deployment

`wrangler.jsonc` configures Worker `deepseek-chat`, D1 `chat` (binding `DB`) and R2 `chat` (binding `FILES`).

```sh
pnpm exec wrangler login
pnpm db:migrate:remote
pnpm deploy
```

In Workers & Pages → deepseek-chat → Settings → Variables and Secrets, configure:

- **Text:** `CF_ACCESS_TEAM_DOMAIN` (e.g. `your-team.cloudflareaccess.com`), `CF_ACCESS_AUD` (admin application's AUD Tag), `ADMIN_EMAILS` (comma-separated emails).
- **Optional Text:** `APP_ORIGIN` (site origin, e.g. `https://chat.example.com`), `DEEPSEEK_API_ORIGIN` (defaults to `https://api.deepseek.com`).
- **Secret:** `DEEPSEEK_API_KEY`, `API_KEY_ENCRYPTION_KEY` (at least 32 random characters; keep a backup).

`keep_vars: true` preserves dashboard text variables during deployment. Replacing the encryption secret makes existing saved API keys unreadable.

Bind a domain to the Worker. In Cloudflare Zero Trust, create a Self-hosted Access application protecting `chat.example.com/api/admin/access*` and allow the administrator emails. Keep the remaining application paths outside this Access policy. Keep R2 public access disabled.

After administrator login, open Settings → General → Manage to create invitations and manage users.

## Validation

```sh
pnpm type
pnpm lint
pnpm test
pnpm build
pnpm exec wrangler deploy --dry-run
```

GitHub Actions runs these checks on pushes and pull requests, or manually. The workflow does not deploy.

## History

Export history from the original demo and import the ZIP here. Imports accept up to 200 conversations and 1 MiB of JSON, with 900 KiB per conversation. See [history format](src/services/chat/history/README.md).

## License

[MIT](LICENSE). Retain `dist/LICENSE` when distributing the app.
