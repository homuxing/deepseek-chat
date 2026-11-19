# Deepseek Chat

English | [简体中文](README.zh-CN.md)

Based on DeepSeek's chat demo, with React, Hono, Cloudflare Workers, D1 and R2.

## Features

- Invitation registration and password login.
- Administrator password login, invitation and user management.
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

For frontend hot reload, also run `pnpm dev` and open `http://localhost:8090`. Administrator login is at `/admin`.

## Deployment

`wrangler.jsonc` configures Worker `deepseek-chat`, D1 `chat` (binding `DB`) and R2 `chat` (binding `FILES`).

Deploy with **Cloudflare Workers**. `pnpm build` generates frontend assets in `dist`; Wrangler bundles the backend from `main: server/index.ts` and publishes both together. A Pages project configured with `pnpm build` and output directory `dist` only publishes this project's frontend and cannot run its authentication API.

### Automatic Git deployment

Create a **Worker** in Cloudflare Workers & Pages, connect the `homuxing/deepseek-chat` repository, and configure:

- Worker name: `deepseek-chat`, matching `wrangler.jsonc`.
- Production branch: `main`, with automatic deployments enabled.
- Root directory: repository root (leave blank).
- Build command: `pnpm build`.
- Deploy command: `pnpm deploy:worker`.
- Build environment: Node.js 24. `packageManager: pnpm@11.5.1` in `package.json` pins pnpm for Cloudflare and GitHub Actions. To override the detected Node.js version, set build variable `NODE_VERSION=24`.

On each push to `main`, Cloudflare builds the frontend and runs `deploy:worker`: apply pending remote D1 migrations, then publish the Worker backend and `dist` assets. A failed migration stops deployment. The build's Cloudflare API token needs Workers Scripts, D1 and R2 permissions for the account, including D1 Edit to apply migrations.

Check that the configured D1 database ID and R2 bucket belong to the account; reuse the existing `chat` database and bucket if applicable. Set the variables listed below in the new Worker's **runtime** Variables and Secrets. Pages variables do not transfer automatically, and build variables are not available at runtime.

After the first deployment, verify the Worker default URL: the page should load, and an unauthenticated request to `/api/auth/me` should return `401`, `application/json`, and a login message. Then remove the `chat.homu.space` custom domain from the old Pages project and add it in the Worker's Domains & Routes. If setting `APP_ORIGIN`, use `https://chat.homu.space` before signing in through the production domain. Once the production domain works, the old Pages project can be deleted.

### Terminal deployment

```sh
pnpm exec wrangler login
pnpm deploy
```

`pnpm deploy` builds the frontend, applies remote D1 migrations, and publishes the frontend and backend together.

In Workers & Pages → deepseek-chat → Settings → Variables and Secrets, configure:

- **Text:** `ADMIN_USERNAME` is set to `Admin` in `wrangler.jsonc` under `vars`. To change it, update the configuration and push (3–32 letters, digits, underscores or hyphens; case-insensitive).
- **Optional Text:** `APP_ORIGIN` (site origin, e.g. `https://chat.example.com`), `DEEPSEEK_API_ORIGIN` (defaults to `https://api.deepseek.com`).
- **Secret:** `ADMIN_PASSWORD` (10–128 characters), `DEEPSEEK_API_KEY`, `API_KEY_ENCRYPTION_KEY` (at least 32 random characters; keep a backup).

`keep_vars: true` preserves dashboard text variables during deployment. Replacing the encryption secret makes existing saved API keys unreadable.

Bind a domain to the Worker and keep R2 public access disabled. The administrator signs in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Changing either setting invalidates existing administrator sessions; ordinary users cannot register the configured administrator username.

Deployment runs `pnpm db:migrate:remote` automatically. The administrator password migration adds session validation and revokes sessions from the previous login method, preserving users and chats. If you previously configured a Cloudflare Access application for this site, disable it to use password login.

After administrator login, open Settings → General → Manage to create invitations and manage users.

## Validation

```sh
pnpm type
pnpm lint
pnpm test
pnpm build
pnpm deploy:dry-run
```

GitHub Actions runs these checks on pushes and pull requests, or manually. Production automatic deployment runs through Cloudflare Workers' Git integration using the build and deploy commands above.

## History

Export history from the original demo and import the ZIP here. Imports accept up to 200 conversations and 1 MiB of JSON, with 900 KiB per conversation. See [history format](src/services/chat/history/README.md).

## License

[MIT](LICENSE). Retain `dist/LICENSE` when distributing the app.
