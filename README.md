# Deepseek Chat

English | [简体中文](README.zh-CN.md)

Based on DeepSeek's chat demo, with React, Hono, Cloudflare Workers, D1 and R2.

## Features

- Invitation registration and password login.
- Administrator password login, invitation and user management.
- Cloud chat history and attachments per user, with official DeepSeek ZIP import, export and automatic multi-device sync.
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

`wrangler.jsonc` configures Worker `deepseek-chat`, D1 `chat` (binding `DB`), private R2 `chat` (binding `FILES`) and Durable Object `HistorySync` (binding `SYNC`). D1 stores the chat directory and versions; R2 stores complete conversation JSON and attachment originals.

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

Cloud history requires `migrations/0004_cloud_history.sql`. It preserves existing users and conversations, adds directory generations, conversation versions, R2 body references, attachment references, and import and multipart upload records. Existing D1 conversation bodies remain readable; subsequent writes use R2. Apply local migrations with `pnpm db:migrate:local`; `pnpm deploy` and `pnpm deploy:worker` apply remote migrations before publishing.

Keep the `SYNC` Durable Object binding and the `history-sync-v1` migration with `new_sqlite_classes: ["HistorySync"]` in `wrangler.jsonc`. Wrangler applies this DO migration when deploying the Worker that exports `HistorySync`. Both the D1 migration and this DO deployment are required for cloud history and automatic multi-device notifications.

In Workers & Pages → deepseek-chat → Settings → Variables and Secrets, configure:

- **Text or Secret:** `ADMIN_USERNAME` (3–32 letters, digits, underscores or hyphens; case-insensitive). Set the administrator username in the Worker's runtime configuration.
- **Optional Text:** `APP_ORIGIN` (site origin, e.g. `https://chat.example.com`), `DEEPSEEK_API_ORIGIN` (defaults to `https://api.deepseek.com`).
- **Secret:** `ADMIN_PASSWORD` (10–128 characters), `DEEPSEEK_API_KEY`, `API_KEY_ENCRYPTION_KEY` (at least 32 random characters; keep a backup).

`keep_vars: true` preserves dashboard text variables during deployment. Replacing the encryption secret makes existing saved API keys unreadable.

`API_KEY_ENCRYPTION_KEY` encrypts custom API keys and requires at least 32 random characters. Invitation codes do not require this secret. Generate a key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`, keep a backup, and set it with `pnpm secret:put API_KEY_ENCRYPTION_KEY --config wrangler.jsonc`. A build environment variable does not provide the runtime secret for custom API keys.

Bind a domain to the Worker and keep R2 public access disabled. The administrator signs in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Changing either setting invalidates existing administrator sessions; ordinary users cannot register the configured administrator username.

Deployment runs `pnpm db:migrate:remote` automatically. The administrator password migration adds session validation and revokes sessions from the previous login method, preserving users and chats. If you previously configured a Cloudflare Access application for this site, disable it to use password login.

After administrator login, open Settings → General → Manage to create invitations and manage users.

Invitation codes are generated randomly and stored as their original strings for administrators to view and copy. Registration validates their hashes, usage limits, and expiration dates without an encryption key. Older records containing only a hash cannot recover their original codes; previously distributed codes remain valid for registration.

`0006_plain_invite_codes.sql` adds the original-code column and preserves all existing records. Database migration commands convert saved invitation ciphertext, and deployment converts any ciphertext created during publication afterward. Existing ciphertext requires the original `API_KEY_ENCRYPTION_KEY`: remote conversion reads `.env.production.encryption` or the command environment; local conversion reads `.dev.vars` or the command environment. Use `node scripts/migrate-invite-codes.mjs --remote --key-file <key-file>` to supply a file containing that variable. An incorrect key or damaged record stops conversion and preserves the original data. After conversion, invitation creation, listing, and registration do not require the key.

Ordinary sessions last seven days. A successful same-origin request renews a session when no more than one day remains, up to an absolute deadline of 30 days after login. Administrator sessions last one day, renew when no more than six hours remain, and require login again after seven days. Expired sessions require login; renewal does not use background polling.

Password resets, account status updates, and administrator chat cleanup revoke the affected user's sessions. Session creation and renewal check the credential version so an in-flight login cannot bypass revocation. The `0003_session_renewal.sql` migration revokes existing sessions while preserving users and chats; users must sign in again after migration.

## Validation

```sh
pnpm type
pnpm lint
pnpm build
pnpm test
pnpm deploy:dry-run
```

GitHub Actions runs these checks on pushes and pull requests, or manually. Production automatic deployment runs through Cloudflare Workers' Git integration using the build and deploy commands above.

## History

Import an official DeepSeek history ZIP with `export_format_version: 3`. Conversations stream directly to cloud storage, preserving the full message tree, current branch, text, reasoning, search results and pinned state. Images, documents and other available originals are stored in R2; shared attachments keep one file identity across conversations. Missing originals retain their metadata. The app sets no business limit on conversation count, individual conversation JSON or total JSON size; practical capacity depends on browser resources and cloud platform limits. ZIP32 and ZIP64 are supported.

D1 stores the per-user directory, versions and attachment references, while R2 stores complete conversation JSON and originals. An import replaces history only after upload and archive validation succeed. Devices signed into the same account receive Durable Object notifications and automatically read updated history, including after reconnecting or returning to the page, without fixed polling or a manual refresh action. See [history format and cloud deployment](src/services/chat/history/README.md).

## License

[MIT](LICENSE). Retain `dist/LICENSE` when distributing the app.
