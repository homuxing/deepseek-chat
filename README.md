# Private DeepSeek Chat

English | [简体中文 / detailed deployment guide](README.zh-CN.md)

A private deployment of DeepSeek's official chat demo. React and Hono run on one Cloudflare Worker. D1 stores users, invitations, login sessions and chat history; a private R2 bucket stores original attachments.

Users register with a username, password and invitation. Administrators sign in through Cloudflare Access with JWT signature, issuer, audience, expiry and email allowlist checks. The admin console creates/deletes invitations, manages users and clears selected users' history. Password changes and account disabling revoke sessions.

All DeepSeek requests use the authenticated Worker proxy, including streaming chat, attachments and speech. A user's custom API key takes precedence over DEEPSEEK_API_KEY. Custom keys are AES-GCM encrypted in D1 and never returned to the browser or stored in localStorage.

## Development

Use Node.js 24 and pnpm:

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm build
pnpm db:migrate:local
pnpm dev:worker
```

Set secrets in `.dev.vars` and visit `http://localhost:8787`. For frontend hot reload, also run `pnpm dev` and visit `http://localhost:8090`; `/api` is proxied to the Worker. Local administrators need a real Access-protected test hostname via Cloudflare Tunnel. There is no production authentication bypass.

## Deployment

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create private-chat
pnpm exec wrangler r2 bucket create private-chat-files
```

Update the D1 database_id in `wrangler.jsonc` and bind a custom domain to the Worker. Create a Cloudflare Access self-hosted application protecting only `chat.example.com/api/admin/access*`. Allow admin emails and configure CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, and comma-separated ADMIN_EMAILS. Set APP_ORIGIN to the public HTTPS origin.

```sh
pnpm exec wrangler secret put DEEPSEEK_API_KEY
pnpm exec wrangler secret put API_KEY_ENCRYPTION_KEY
pnpm db:migrate:remote
pnpm deploy
```

Use a random encryption secret of at least 32 characters and keep a backup. Replacing it without migrating ciphertext makes existing saved custom keys unreadable. Keep R2 private. Click administrator sign-in, then open Settings → General → Manage to create invitations.

## Storage and validation

History is scoped to the authenticated user and available across devices. ZIP imports replace chats atomically with new IDs for imported originals, so failed imports cannot overwrite old originals. Imports accept at most 200 conversations and 1 MiB of JSON; each conversation is limited to 900 KiB. Browser IndexedDB data is not automatically migrated; export from the original demo and import here.

Deleting chats cleans up unreferenced R2 originals. DeepSeek's uploaded files are not automatically deleted. Messages, attachments and speech are still sent to DeepSeek. Original chat model and protocol extensions remain unchanged.

```sh
pnpm type
pnpm lint
pnpm test
pnpm build
pnpm exec wrangler deploy --dry-run
```

CI runs validation only. No GitHub Pages publication or automatic cloud deployment is configured.

[MIT](LICENSE). Keep dist/LICENSE when distributing the app.
