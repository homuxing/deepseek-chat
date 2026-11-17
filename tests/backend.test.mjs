import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

mkdirSync('test-results', { recursive: true })
await build({
  stdin: {
    contents: "export { app } from './server/index.ts'; export * from './server/security.ts'",
    resolveDir: process.cwd(),
    sourcefile: 'tests-entry.ts',
    loader: 'ts',
  },
  outfile: 'test-results/backend.mjs',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
})
const { app, sha256, decryptApiKey, verifyAccessIdentity } =
  await import('../test-results/backend.mjs')

// A D1 adapter backed by real SQLite validates queries, constraints and atomic rollback.
class LocalD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:')
    this.db.exec(readFileSync('migrations/0001_initial.sql', 'utf8'))
  }
  prepare(sql) {
    const execute = (params, kind) => {
      this.beforeExecute?.(sql)
      const statement = this.db.prepare(sql)
      const hasRows = /^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)
      const rows = hasRows ? statement.all(...params) : []
      if (!hasRows) {
        statement.run(...params)
      }
      const changes = Number(this.db.prepare('SELECT changes() AS n').get().n)
      if (kind === 'first') {
        return rows[0] ?? null
      }
      return { success: true, results: rows, meta: { changes } }
    }
    const bind = (...params) => ({
      first: async () => execute(params, 'first'),
      all: async () => execute(params, 'all'),
      run: async () => execute(params, 'run'),
    })
    return { bind, ...bind() }
  }
  async batch(statements) {
    this.db.exec('BEGIN')
    try {
      const rows = []
      for (const statement of statements) {
        rows.push(await statement.run())
      }
      this.db.exec('COMMIT')
      return rows
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

class LocalR2 {
  objects = new Map()
  async put(key, bytes, options) {
    const value =
      bytes instanceof ReadableStream
        ? new Uint8Array(await new Response(bytes).arrayBuffer())
        : new Uint8Array(bytes)
    this.objects.set(key, { bytes: value, options })
    await this.afterPut?.(key)
    return { size: value.byteLength }
  }
  async get(key) {
    const value = this.objects.get(key)
    return value ? { body: value.bytes, size: value.bytes.length } : null
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key)
    }
  }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort()
    const offset = cursor ? Number(cursor) : 0
    const selected = keys.slice(offset, offset + limit)
    const truncated = offset + selected.length < keys.length
    return {
      objects: selected.map((key) => ({ key, size: this.objects.get(key).bytes.byteLength })),
      truncated,
      ...(truncated ? { cursor: String(offset + selected.length) } : {}),
    }
  }
}

const db = new LocalD1()
const env = {
  DB: db,
  FILES: new LocalR2(),
  ASSETS: {
    fetch: async () =>
      new Response('<html>private chat</html>', { headers: { 'Content-Type': 'text/html' } }),
  },
  DEEPSEEK_API_KEY: 'sk-deployment-secret',
  API_KEY_ENCRYPTION_KEY: 'test-encryption-secret-with-more-than-32-characters',
  CF_ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'test-access-aud',
  ADMIN_EMAILS: 'admin@example.com',
}
let keyPair, jwk
const originalFetch = globalThis.fetch
const upstreamCalls = []
let uploadSequence = 0
before(async () => {
  keyPair = await generateKeyPair('RS256')
  jwk = { ...(await exportJWK(keyPair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === 'https://test-team.cloudflareaccess.com/cdn-cgi/access/certs') {
      return Response.json({ keys: [jwk] })
    }
    assert.ok(url.startsWith('https://api.deepseek.com/'), `unexpected outbound URL ${url}`)
    upstreamCalls.push({ url, ...init })
    if (url.endsWith('/files') && init?.method === 'POST') {
      return Response.json({ id: `file-api-${++uploadSequence}`, filename: 'picture.png' })
    }
    if (url.endsWith('/messages')) {
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'upstream-secret=bad' },
      })
    }
    return Response.json({ data: [{ id: 'deepseek-flash' }] })
  }
})
after(() => {
  globalThis.fetch = originalFetch
  db.db.close()
})

const accessToken = async (options = {}) =>
  new SignJWT({ email: options.email ?? 'admin@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('admin-subject')
    .setIssuer('https://test-team.cloudflareaccess.com')
    .setAudience(options.audience ?? env.CF_ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(options.expiry ?? '5m')
    .sign(keyPair.privateKey)

const call = (path, { method = 'GET', body, cookie, headers = {}, csrf = true, origin } = {}) =>
  app.request(
    `https://chat.example.com${path}`,
    {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf && method !== 'GET' ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
        ...(typeof body === 'object' && !(body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(origin ? { Origin: origin } : {}),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData || typeof body === 'string'
            ? body
            : JSON.stringify(body),
    },
    env
  )

const cookieFrom = (res, name = 'private_chat_session') => {
  const match = res.headers.get('set-cookie')?.match(new RegExp(`${name}=([^; ,]+)`))
  assert.ok(match, `missing ${name} cookie`)
  return `${name}=${match[1]}`
}
const createInvite = async (cookie, maxUses = 1) => {
  const res = await call('/api/admin/invites', { method: 'POST', cookie, body: { maxUses } })
  assert.equal(res.status, 201)
  return (await res.json()).invite
}
const register = async (username, code) => {
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'a-good-password', inviteCode: code },
  })
  assert.equal(res.status, 201, await res.clone().text())
  return { cookie: cookieFrom(res), user: (await res.json()).user }
}
let admin, alice, bob

test('auth fails closed; CSRF and administrator Access signatures are enforced', async () => {
  assert.equal((await call('/api/chats')).status, 401)
  assert.equal((await call('/api/admin/users')).status, 401)
  assert.equal(
    (await call('/api/auth/login', { method: 'POST', csrf: false, body: {} })).status,
    403
  )
  assert.equal(
    (await call('/api/auth/login', { method: 'POST', origin: 'https://evil.example', body: {} }))
      .status,
    403
  )
  assert.equal((await call('/api/admin/access')).status, 401)
  assert.equal(
    (await call('/api/admin/access', { headers: { 'Cf-Access-Jwt-Assertion': 'forged-token' } }))
      .status,
    403
  )
  await assert.rejects(verifyAccessIdentity(await accessToken({ audience: 'wrong-aud' }), env))
  await assert.rejects(
    verifyAccessIdentity(await accessToken({ email: 'outsider@example.com' }), env)
  )
  await assert.rejects(
    verifyAccessIdentity(await accessToken({ expiry: Math.floor(Date.now() / 1000) - 60 }), env)
  )
  const entry = await call('/api/admin/access', {
    headers: { 'Cf-Access-Jwt-Assertion': await accessToken() },
  })
  assert.equal(entry.status, 303)
  assert.equal(entry.headers.get('Location'), '/api/admin/access/callback')
  const handoff = cookieFrom(entry, 'private_chat_admin_handoff')
  assert.equal((await call('/api/admin/access/callback')).status, 200)
  const login = await call('/api/admin/login', { method: 'POST', cookie: handoff })
  assert.equal(login.status, 200)
  assert.match(login.headers.get('set-cookie'), /HttpOnly/)
  assert.match(login.headers.get('set-cookie'), /Secure/)
  admin = { cookie: cookieFrom(login), user: (await login.json()).user }
  assert.equal(admin.user.role, 'admin')
  assert.equal((await call('/api/admin/login', { method: 'POST', cookie: handoff })).status, 401)
})

test('invite consumption is bounded and failed registration rolls back usage', async () => {
  const invite = await createInvite(admin.cookie, 2)
  alice = await register('alice', invite.code)
  const duplicate = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'ALICE', password: 'another-password', inviteCode: invite.code },
  })
  assert.equal(duplicate.status, 409)
  assert.equal(db.db.prepare('SELECT uses FROM invites WHERE id = ?').get(invite.id).uses, 1)
  bob = await register('bob', invite.code)
  assert.equal(
    (
      await call('/api/auth/register', {
        method: 'POST',
        body: { username: 'carol', password: 'another-password', inviteCode: invite.code },
      })
    ).status,
    400
  )
  const single = await createInvite(admin.cookie)
  const attempts = await Promise.all(
    ['carol', 'david'].map((username) =>
      call('/api/auth/register', {
        method: 'POST',
        body: { username, password: 'another-password', inviteCode: single.code },
      })
    )
  )
  assert.deepEqual(attempts.map((res) => res.status).sort(), [201, 400])
  const listed = await (await call('/api/admin/invites', { cookie: admin.cookie })).json()
  assert.ok(listed.invites.every((item) => item.code === null))
  assert.ok(!JSON.stringify(listed).includes(invite.code))
  assert.equal((await call('/api/admin/users', { cookie: alice.cookie })).status, 403)
})

const session = (title = 'Alice private chat') => ({
  id: 'shared-id',
  title,
  createdAt: 1,
  updatedAt: 2,
  messages: [],
})
test('D1 chats and R2 originals remain isolated even with identical identifiers', async () => {
  const stale = await call('/api/chats/shared-id', {
    method: 'PUT',
    cookie: bob.cookie,
    headers: { 'X-Chat-User-ID': alice.user.id },
    body: { session: session() },
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.headers.get('X-Auth-Expired'), '1')
  assert.equal(
    (
      await call('/api/chats/shared-id', {
        method: 'PUT',
        cookie: alice.cookie,
        body: { session: session() },
      })
    ).status,
    204
  )
  assert.equal((await call('/api/chats/shared-id', { cookie: bob.cookie })).status, 404)
  assert.equal(
    (
      await call('/api/chats/shared-id', {
        method: 'PUT',
        cookie: bob.cookie,
        body: { session: session('Bob private chat') },
      })
    ).status,
    204
  )
  await call('/api/chats/shared-id', {
    method: 'PATCH',
    cookie: bob.cookie,
    body: { title: 'Bob renamed' },
  })
  assert.equal(
    (await (await call('/api/chats/shared-id', { cookie: alice.cookie })).json()).session.title,
    'Alice private chat'
  )
  await call('/api/chats/shared-id', { method: 'DELETE', cookie: bob.cookie })
  assert.equal((await call('/api/chats/shared-id', { cookie: alice.cookie })).status, 200)
  const upload = await call('/api/files/picture-id', {
    method: 'POST',
    cookie: alice.cookie,
    body: 'image-bytes',
    headers: { 'Content-Type': 'image/png' },
  })
  assert.equal(upload.status, 204)
  assert.equal((await call('/api/files/picture-id', { cookie: bob.cookie })).status, 404)
  const original = await call('/api/files/picture-id', { cookie: alice.cookie })
  assert.equal(await original.text(), 'image-bytes')
  assert.match(original.headers.get('content-disposition'), /attachment/)
  assert.equal((await call('/api/files/%2E%2E%2Fother', { cookie: alice.cookie })).status, 400)
  const users = (await (await call('/api/admin/users', { cookie: admin.cookie })).json()).users
  assert.equal(users.find((user) => user.id === alice.user.id).sessionCount, 1)
})

test('chat deletion preserves shared originals and successful import removes unreferenced files', async () => {
  const attachment = {
    id: 'picture-id',
    serverId: null,
    name: 'picture.png',
    size: 11,
    isImage: true,
    mimeType: 'image/png',
  }
  const withFile = (id) => ({
    ...session(),
    id,
    messages: [{ id: 'msg-1', role: 'user', content: '', files: [attachment], createdAt: 2 }],
  })
  for (const id of ['first', 'second']) {
    assert.equal(
      (
        await call(`/api/chats/${id}`, {
          method: 'PUT',
          cookie: alice.cookie,
          body: { session: withFile(id) },
        })
      ).status,
      204
    )
  }
  assert.equal(
    (await call('/api/chats/first', { method: 'DELETE', cookie: alice.cookie })).status,
    204
  )
  assert.equal((await call('/api/files/picture-id', { cookie: alice.cookie })).status, 200)
  assert.equal(
    (await call('/api/chats/second', { method: 'DELETE', cookie: alice.cookie })).status,
    204
  )
  assert.equal((await call('/api/files/picture-id', { cookie: alice.cookie })).status, 404)
  await call('/api/files/unreferenced', { method: 'POST', cookie: alice.cookie, body: 'unused' })
  const invalid = await call('/api/chats/import', {
    method: 'POST',
    cookie: alice.cookie,
    body: { sessions: [session(), session()] },
  })
  assert.equal(invalid.status, 400)
  assert.equal((await call('/api/chats/shared-id', { cookie: alice.cookie })).status, 200)
  const imported = await call('/api/chats/import', {
    method: 'POST',
    cookie: alice.cookie,
    body: { sessions: [session()] },
  })
  assert.equal(imported.status, 200)
  assert.equal((await call('/api/files/unreferenced', { cookie: alice.cookie })).status, 404)
})

test('custom keys are encrypted and take precedence; shared upstream files enforce ownership', async () => {
  await call('/api/models', { cookie: alice.cookie })
  assert.equal(upstreamCalls.at(-1).headers.get('Authorization'), `Bearer ${env.DEEPSEEK_API_KEY}`)
  const result = await call('/api/settings/api-key', {
    method: 'PUT',
    cookie: alice.cookie,
    body: { apiKey: 'sk-alice-secret' },
  })
  assert.equal(result.status, 200)
  const ciphertext = db.db
    .prepare('SELECT api_key_ciphertext FROM users WHERE id=?')
    .get(alice.user.id).api_key_ciphertext
  assert.ok(!ciphertext.includes('sk-alice-secret'))
  assert.equal(await decryptApiKey(ciphertext, env.API_KEY_ENCRYPTION_KEY), 'sk-alice-secret')
  await call('/api/models', { cookie: alice.cookie, headers: { 'x-api-key': 'sk-attacker' } })
  assert.equal(upstreamCalls.at(-1).headers.get('Authorization'), 'Bearer sk-alice-secret')
  await call('/api/models', { cookie: bob.cookie })
  assert.equal(upstreamCalls.at(-1).headers.get('Authorization'), `Bearer ${env.DEEPSEEK_API_KEY}`)
  const settings = await (await call('/api/settings', { cookie: alice.cookie })).text()
  assert.ok(!settings.includes('sk-alice-secret'))
  const form = new FormData()
  form.append('file', new Blob(['picture'], { type: 'image/png' }), 'picture.png')
  const fileRes = await call('/api/anthropic/v1/files', {
    method: 'POST',
    cookie: alice.cookie,
    body: form,
  })
  assert.equal(fileRes.status, 200)
  const file = await fileRes.json()
  const body = {
    model: 'deepseek-flash',
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: file.id } }] },
    ],
  }
  const denied = await call('/api/anthropic/v1/messages', {
    method: 'POST',
    cookie: bob.cookie,
    body,
  })
  assert.equal(denied.status, 400)
  const allowed = await call('/api/anthropic/v1/messages', {
    method: 'POST',
    cookie: alice.cookie,
    body,
  })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('Content-Type'), 'text/event-stream')
  assert.equal(allowed.headers.get('Set-Cookie'), null)
  assert.match(await allowed.text(), /message_stop/)
  await call('/api/settings/api-key', { method: 'DELETE', cookie: alice.cookie })
  await call('/api/models', { cookie: alice.cookie })
  assert.equal(upstreamCalls.at(-1).headers.get('Authorization'), `Bearer ${env.DEEPSEEK_API_KEY}`)
  assert.equal(
    (await call('/api/anthropic/v1/messages', { method: 'POST', cookie: alice.cookie, body }))
      .status,
    400
  )
})

test('administrator account guards, password resets, disabling and chat cleanup', async () => {
  assert.equal(
    (await call(`/api/admin/users/${admin.user.id}`, { method: 'DELETE', cookie: admin.cookie }))
      .status,
    400
  )
  assert.equal(
    (
      await call(`/api/admin/users/${admin.user.id}`, {
        method: 'PATCH',
        cookie: admin.cookie,
        body: { status: 'disabled' },
      })
    ).status,
    400
  )
  assert.equal(
    (
      await call(`/api/admin/users/${admin.user.id}`, {
        method: 'PATCH',
        cookie: admin.cookie,
        body: { password: 'new-admin-password' },
      })
    ).status,
    400
  )
  assert.equal(
    (
      await call(`/api/admin/users/${alice.user.id}`, {
        method: 'PATCH',
        cookie: admin.cookie,
        body: { password: 'new-alice-password' },
      })
    ).status,
    200
  )
  assert.equal((await call('/api/chats', { cookie: alice.cookie })).status, 401)
  const loggedIn = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'new-alice-password' },
  })
  assert.equal(loggedIn.status, 200)
  alice.cookie = cookieFrom(loggedIn)
  assert.equal(
    (
      await call(`/api/admin/users/${alice.user.id}/chats`, {
        method: 'DELETE',
        cookie: admin.cookie,
      })
    ).status,
    204
  )
  assert.equal(
    db.db.prepare('SELECT COUNT(*) AS n FROM chats WHERE user_id=?').get(alice.user.id).n,
    0
  )
  assert.equal(env.FILES.objects.size, 0)
  assert.equal(
    (
      await call(`/api/admin/users/${bob.user.id}`, {
        method: 'PATCH',
        cookie: admin.cookie,
        body: { status: 'disabled' },
      })
    ).status,
    200
  )
  assert.equal((await call('/api/models', { cookie: bob.cookie })).status, 401)
  assert.equal(
    (
      await call('/api/auth/login', {
        method: 'POST',
        body: { username: 'bob', password: 'a-good-password' },
      })
    ).status,
    401
  )
  assert.equal(
    (await call(`/api/admin/users/${bob.user.id}`, { method: 'DELETE', cookie: admin.cookie }))
      .status,
    204
  )
  assert.equal(db.db.prepare('SELECT id FROM users WHERE id=?').get(bob.user.id), undefined)
})

test('revocation during an in-flight write prevents chats and originals from being restored', async () => {
  const invite = await createInvite(admin.cookie)
  const account = await register('race_user', invite.code)
  db.beforeExecute = (sql) => {
    if (/^\s*INSERT INTO chats/i.test(sql)) {
      db.beforeExecute = undefined
      db.db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(account.user.id)
    }
  }
  const saved = await call('/api/chats/shared-id', {
    method: 'PUT',
    cookie: account.cookie,
    body: { session: session() },
  })
  assert.equal(saved.status, 401)
  assert.equal(
    db.db.prepare('SELECT COUNT(*) AS n FROM chats WHERE user_id=?').get(account.user.id).n,
    0
  )
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'race_user', password: 'a-good-password' },
  })
  const cookie = cookieFrom(login)
  env.FILES.afterPut = async () => {
    env.FILES.afterPut = undefined
    db.db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(account.user.id)
  }
  const uploaded = await call('/api/files/revoked-file', {
    method: 'POST',
    cookie,
    body: 'picture',
  })
  assert.equal(uploaded.status, 401)
  assert.equal(env.FILES.objects.has(`${account.user.id}/revoked-file`), false)
  assert.equal(
    db.db.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id=?').get(account.user.id).n,
    0
  )
})
