import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { build } from 'esbuild'

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
const { app, sha256, decryptApiKey } = await import('../test-results/backend.mjs')

// A D1 adapter backed by real SQLite validates queries, constraints and atomic rollback.
class LocalD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:')
    for (const file of readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      this.db.exec(readFileSync('migrations/' + file, 'utf8'))
    }
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
      new Response('<html>Deepseek Chat</html>', { headers: { 'Content-Type': 'text/html' } }),
  },
  DEEPSEEK_API_KEY: 'sk-deployment-secret',
  API_KEY_ENCRYPTION_KEY: 'test-encryption-secret-with-more-than-32-characters',
  ADMIN_USERNAME: 'super_admin',
  ADMIN_PASSWORD: 'test-super-admin-password',
}
const originalFetch = globalThis.fetch
const upstreamCalls = []
let uploadSequence = 0
before(async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input)
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

const cookieFrom = (res, name = 'deepseek_chat_session') => {
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

test('administrator configuration errors identify missing or invalid bindings without exposing values', async () => {
  const configDb = new LocalD1()
  const cases = [
    { ADMIN_USERNAME: undefined, message: /未读取到 ADMIN_USERNAME/ },
    { ADMIN_USERNAME: '   ', message: /未读取到 ADMIN_USERNAME/ },
    { ADMIN_USERNAME: 'invalid.username', message: /ADMIN_USERNAME 配置无效/ },
    { ADMIN_PASSWORD: undefined, message: /未读取到 ADMIN_PASSWORD/ },
    { ADMIN_PASSWORD: '', message: /未读取到 ADMIN_PASSWORD/ },
    { ADMIN_PASSWORD: 'short', message: /ADMIN_PASSWORD 配置无效/ },
    { ADMIN_PASSWORD: 'x'.repeat(129), message: /ADMIN_PASSWORD 配置无效/ },
  ]
  try {
    for (const { message, ...config } of cases) {
      const response = await app.request(
        'https://chat.example.com/api/admin/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ username: 'super_admin', password: 'a-test-password' }),
        },
        { ...env, ...config, DB: configDb }
      )
      assert.equal(response.status, 503)
      const body = await response.json()
      assert.match(body.error.message, message)
      assert.ok(!JSON.stringify(body).includes(env.ADMIN_PASSWORD))
      for (const value of Object.values(config)) {
        if (typeof value === 'string' && value.trim()) {
          assert.ok(!JSON.stringify(body).includes(value))
        }
      }
    }
    assert.equal(
      configDb.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n,
      0
    )
  } finally {
    configDb.db.close()
  }
})

test('auth fails closed; CSRF and environment administrator credentials are enforced', async () => {
  assert.equal((await call('/api/chats')).status, 401)
  assert.equal((await call('/api/admin/users')).status, 401)
  assert.equal((await call('/admin')).status, 200)
  assert.equal(
    (await call('/api/auth/login', { method: 'POST', csrf: false, body: {} })).status,
    403
  )
  assert.equal(
    (await call('/api/auth/login', { method: 'POST', origin: 'https://evil.example', body: {} }))
      .status,
    403
  )
  const credentials = { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }
  assert.equal(
    (await call('/api/admin/login', { method: 'POST', csrf: false, body: credentials })).status,
    403
  )
  assert.equal(
    (
      await call('/api/admin/login', {
        method: 'POST',
        origin: 'https://evil.example',
        body: credentials,
      })
    ).status,
    403
  )
  assert.equal((await call('/api/admin/access')).status, 401)
  assert.equal((await call('/api/admin/access/callback')).status, 401)
  const originalPassword = env.ADMIN_PASSWORD
  delete env.ADMIN_PASSWORD
  const unconfigured = await call('/api/admin/login', { method: 'POST', body: credentials })
  assert.equal(unconfigured.status, 503)
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n, 0)
  env.ADMIN_PASSWORD = originalPassword
  assert.equal(
    (
      await call('/api/admin/login', {
        method: 'POST',
        body: { ...credentials, password: 'incorrect-password' },
      })
    ).status,
    401
  )
  assert.equal(
    (
      await call('/api/admin/login', {
        method: 'POST',
        body: { ...credentials, username: 'wrong-admin' },
      })
    ).status,
    401
  )
  assert.equal((await call('/api/auth/login', { method: 'POST', body: credentials })).status, 401)
  const login = await call('/api/admin/login', {
    method: 'POST',
    body: { ...credentials, username: env.ADMIN_USERNAME.toUpperCase() },
  })
  assert.equal(login.status, 200, await login.clone().text())
  assert.match(login.headers.get('set-cookie'), /HttpOnly/)
  assert.match(login.headers.get('set-cookie'), /Secure/)
  admin = { cookie: cookieFrom(login), user: (await login.json()).user }
  assert.equal(admin.user.role, 'admin')
  assert.equal(admin.user.username, env.ADMIN_USERNAME)
  assert.equal((await call('/api/auth/me', { cookie: admin.cookie })).status, 200)
  assert.equal(
    db.db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.user.id).password_hash,
    null
  )
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

const session = (title = 'Alice chat') => ({
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
        body: { session: session('Bob chat') },
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
    'Alice chat'
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

test('administrator credential changes revoke old sessions and preserve the stable account', async () => {
  db.db.prepare('DELETE FROM rate_limits').run()
  const id = admin.user.id
  const password = env.ADMIN_PASSWORD
  const username = env.ADMIN_USERNAME
  const signIn = async () => {
    const response = await call('/api/admin/login', {
      method: 'POST',
      body: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD },
    })
    assert.equal(response.status, 200, await response.clone().text())
    return { cookie: cookieFrom(response), user: (await response.json()).user }
  }
  try {
    const second = await signIn()
    env.ADMIN_PASSWORD = 'a-rotated-admin-password'
    const stale = await call('/api/admin/users', { cookie: admin.cookie })
    assert.equal(stale.status, 401)
    assert.equal(stale.headers.get('X-Auth-Expired'), '1')
    assert.equal(
      (await call('/api/admin/login', { method: 'POST', body: { username, password } })).status,
      401
    )
    admin = await signIn()
    assert.equal(admin.user.id, id)
    assert.equal((await call('/api/admin/users', { cookie: second.cookie })).status, 401)
    env.ADMIN_USERNAME = 'renamed_admin'
    assert.equal((await call('/api/admin/users', { cookie: admin.cookie })).status, 401)
    admin = await signIn()
    assert.equal(admin.user.id, id)
    assert.equal(admin.user.username, 'renamed_admin')
    delete env.ADMIN_PASSWORD
    assert.equal((await call('/api/admin/users', { cookie: admin.cookie })).status, 401)
  } finally {
    env.ADMIN_USERNAME = username
    env.ADMIN_PASSWORD = password
    admin = await signIn()
  }
})

test('administrator username reservations and collisions cannot promote normal users', async () => {
  db.db.prepare('DELETE FROM rate_limits').run()
  const invite = await createInvite(admin.cookie, 2)
  const reserved = await call('/api/auth/register', {
    method: 'POST',
    body: {
      username: env.ADMIN_USERNAME.toUpperCase(),
      password: 'normal-user-password',
      inviteCode: invite.code,
    },
  })
  assert.equal(reserved.status, 409)
  assert.equal(db.db.prepare('SELECT uses FROM invites WHERE id=?').get(invite.id).uses, 0)
  const normal = await register('future_admin', invite.code)
  const username = env.ADMIN_USERNAME
  try {
    env.ADMIN_USERNAME = normal.user.username
    const collision = await call('/api/admin/login', {
      method: 'POST',
      body: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD },
    })
    assert.equal(collision.status, 409)
    assert.equal(
      db.db.prepare('SELECT role FROM users WHERE id=?').get(normal.user.id).role,
      'user'
    )
    assert.equal((await call('/api/admin/users', { cookie: normal.cookie })).status, 403)
  } finally {
    env.ADMIN_USERNAME = username
  }
})

test('administrator password attempts are rate limited', async () => {
  db.db.prepare('DELETE FROM rate_limits').run()
  for (let i = 0; i < 10; i++) {
    assert.equal(
      (
        await call('/api/admin/login', {
          method: 'POST',
          body: { username: env.ADMIN_USERNAME, password: 'incorrect-password' },
        })
      ).status,
      401
    )
  }
  const blocked = await call('/api/admin/login', {
    method: 'POST',
    body: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD },
  })
  assert.equal(blocked.status, 429)
  assert.equal(blocked.headers.get('Retry-After'), '900')
})

test('administrator migration preserves users and chats and revokes legacy sessions', () => {
  const legacy = new DatabaseSync(':memory:')
  try {
    legacy.exec(readFileSync('migrations/0001_initial.sql', 'utf8'))
    legacy.exec(`
      INSERT INTO users (id, username, role, status, created_at, access_sub)
      VALUES ('old-admin', 'admin@example.com', 'admin', 'active', 1, 'access-sub'),
             ('old-user', 'existing_user', 'user', 'active', 1, NULL);
      INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
      VALUES ('admin-token', 'old-admin', 9999999999999, 1),
             ('user-token', 'old-user', 9999999999999, 1);
      INSERT INTO chats (user_id, id, title, created_at, updated_at, data_json)
      VALUES ('old-admin', 'chat', 'Admin history', 1, 1, '{}'),
             ('old-user', 'chat', 'User history', 1, 1, '{}');
      INSERT INTO login_handoffs (token_hash, user_id, expires_at) VALUES ('handoff', 'old-admin', 9);
    `)
    legacy.exec(readFileSync('migrations/0002_admin_password.sql', 'utf8'))
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2)
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM chats').get().n, 2)
    assert.equal(
      legacy.prepare("SELECT token_hash FROM auth_sessions WHERE user_id='old-admin'").get(),
      undefined
    )
    assert.equal(
      legacy
        .prepare("SELECT admin_credential_hash FROM auth_sessions WHERE user_id='old-user'")
        .get().admin_credential_hash,
      null
    )
    assert.equal(
      legacy.prepare("SELECT name FROM sqlite_master WHERE name='login_handoffs'").get(),
      undefined
    )
  } finally {
    legacy.close()
  }
})

const DAY = 24 * 60 * 60 * 1000
const sessionRecord = async (cookie) =>
  db.db
    .prepare('SELECT * FROM auth_sessions WHERE token_hash = ?')
    .get(await sha256(cookie.split('=')[1]))

const renewalAccount = async (username) => {
  db.db.prepare('DELETE FROM rate_limits').run()
  const invite = await createInvite(admin.cookie)
  return register(username, invite.code)
}

const atTime = async (now, action) => {
  const originalNow = Date.now
  Date.now = () => now
  try {
    return await action()
  } finally {
    Date.now = originalNow
  }
}

// 在目标 SQL 执行前完成真实的账户操作，模拟密码校验和会话写入之间的并发。
const beforeStatement = async (matches, action, request) => {
  const originalPrepare = db.prepare
  let intercepted = false
  db.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql)
    if (!matches(sql)) {
      return statement
    }
    return {
      ...statement,
      bind: (...params) => {
        const bound = statement.bind(...params)
        const execute = (kind) => async () => {
          if (!intercepted) {
            intercepted = true
            await action()
          }
          return bound[kind]()
        }
        return { ...bound, run: execute('run'), first: execute('first') }
      },
    }
  }
  try {
    const response = await request()
    assert.equal(intercepted, true)
    return response
  } finally {
    db.prepare = originalPrepare
  }
}

test('password resets, status changes and administrative revocation block an in-flight login', async () => {
  for (const change of ['password', 'status', 'chats']) {
    const account = await renewalAccount(`login_race_${change}`)
    const version = (await sessionRecord(account.cookie)).auth_version
    const response = await beforeStatement(
      (sql) => sql.startsWith('INSERT INTO auth_sessions'),
      async () => {
        const update = await call(
          `/api/admin/users/${account.user.id}${change === 'chats' ? '/chats' : ''}`,
          {
            method: change === 'chats' ? 'DELETE' : 'PATCH',
            cookie: admin.cookie,
            ...(change === 'chats'
              ? {}
              : {
                  body:
                    change === 'password'
                      ? { password: 'changed-password' }
                      : { status: 'disabled' },
                }),
          }
        )
        assert.equal(update.status, change === 'chats' ? 204 : 200)
        if (change === 'status') {
          const enabled = await call(`/api/admin/users/${account.user.id}`, {
            method: 'PATCH',
            cookie: admin.cookie,
            body: { status: 'active' },
          })
          assert.equal(enabled.status, 200)
        }
      },
      () =>
        call('/api/auth/login', {
          method: 'POST',
          body: { username: account.user.username, password: 'a-good-password' },
        })
    )
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(
      db.db
        .prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?')
        .get(account.user.id).n,
      0
    )
    assert.ok(
      db.db.prepare('SELECT auth_version FROM users WHERE id = ?').get(account.user.id)
        .auth_version > version
    )
  }
})

test('sessions remain bound to their credential version even when revocation deletion is omitted', async () => {
  const account = await renewalAccount('credential_binding')
  const old = await sessionRecord(account.cookie)
  db.db.prepare('UPDATE users SET password_hash = password_hash WHERE id = ?').run(account.user.id)
  assert.ok(await sessionRecord(account.cookie))
  const response = await call('/api/auth/me', { cookie: account.cookie })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('X-Auth-Expired'), '1')
  assert.equal((await sessionRecord(account.cookie)).auth_version, old.auth_version)
})

test('ordinary sessions renew the same token near expiry and keep cookie and server deadlines aligned', async () => {
  const account = await renewalAccount('sliding_session')
  const initial = await sessionRecord(account.cookie)
  assert.equal(initial.expires_at - initial.created_at, 7 * DAY)
  assert.equal(initial.absolute_expires_at - initial.created_at, 30 * DAY)
  assert.equal(Buffer.from(account.cookie.split('=')[1], 'base64url').length, 32)
  await atTime(initial.created_at + 5 * DAY, async () => {
    const response = await call('/api/auth/me', { cookie: account.cookie })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal((await sessionRecord(account.cookie)).expires_at, initial.expires_at)
  })
  await atTime(initial.created_at + 6 * DAY, async () => {
    const responses = await Promise.all(
      ['/api/auth/me', '/api/chats'].map((path) => call(path, { cookie: account.cookie }))
    )
    let renewedCookies = 0
    for (const response of responses) {
      assert.equal(response.status, 200)
      // 并发请求可能在另一请求续期后读取会话，此时不必再次设置 Cookie。
      if (!response.headers.has('set-cookie')) {
        continue
      }
      renewedCookies++
      assert.equal(cookieFrom(response), account.cookie)
      assert.match(response.headers.get('set-cookie'), /Max-Age=604800/)
      assert.match(response.headers.get('set-cookie'), /HttpOnly/)
      assert.match(response.headers.get('set-cookie'), /Secure/)
      assert.match(response.headers.get('set-cookie'), /SameSite=Lax/)
      assert.ok(
        response.headers.get('set-cookie').includes(new Date(Date.now() + 7 * DAY).toUTCString())
      )
    }
    assert.ok(renewedCookies >= 1)
    assert.equal((await sessionRecord(account.cookie)).expires_at, Date.now() + 7 * DAY)
    assert.equal(
      (await sessionRecord(account.cookie)).absolute_expires_at,
      initial.absolute_expires_at
    )
    const subsequent = await call('/api/chats', { cookie: account.cookie })
    assert.equal(subsequent.headers.get('set-cookie'), null)
  })
})

test('renewal respects the thirty-day absolute deadline and expired sessions cannot be revived', async () => {
  const account = await renewalAccount('absolute_deadline')
  const initial = await sessionRecord(account.cookie)
  for (const days of [6, 12, 18, 24]) {
    await atTime(initial.created_at + days * DAY, async () => {
      const response = await call('/api/auth/me', { cookie: account.cookie })
      assert.equal(response.status, 200)
      assert.equal(
        (await sessionRecord(account.cookie)).expires_at,
        Math.min(Date.now() + 7 * DAY, initial.absolute_expires_at)
      )
    })
  }
  await atTime(initial.absolute_expires_at - DAY / 2, async () => {
    const response = await call('/api/chats', { cookie: account.cookie })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('set-cookie'), null)
  })
  await atTime(initial.absolute_expires_at, async () => {
    const response = await call('/api/auth/me', { cookie: account.cookie })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(response.headers.get('X-Auth-Expired'), '1')
  })
  const idle = await renewalAccount('idle_expiration')
  const idleSession = await sessionRecord(idle.cookie)
  await atTime(idleSession.expires_at, async () => {
    assert.equal((await call('/api/chats', { cookie: idle.cookie })).status, 401)
    assert.equal((await sessionRecord(idle.cookie)).expires_at, idleSession.expires_at)
  })
})

test('administrator sessions renew daily, stop after seven days and reject changed credentials', async () => {
  db.db.prepare('DELETE FROM rate_limits').run()
  const login = await call('/api/admin/login', {
    method: 'POST',
    body: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD },
  })
  const cookie = cookieFrom(login)
  const initial = await sessionRecord(cookie)
  assert.equal(initial.expires_at - initial.created_at, DAY)
  assert.equal(initial.absolute_expires_at - initial.created_at, 7 * DAY)
  for (let day = 0; day < 8; day++) {
    await atTime(initial.created_at + day * ((3 * DAY) / 4), async () => {
      const response = await call('/api/auth/me', { cookie })
      assert.equal(response.status, 200)
      if (day > 0) {
        assert.equal(cookieFrom(response), cookie)
        assert.match(response.headers.get('set-cookie'), /Max-Age=86400/)
      }
    })
  }
  await atTime(initial.created_at + 6 * DAY, async () => {
    const response = await call('/api/admin/users', { cookie })
    assert.equal(response.status, 200)
    assert.equal((await sessionRecord(cookie)).expires_at, initial.absolute_expires_at)
  })
  await atTime(initial.absolute_expires_at, async () => {
    assert.equal((await call('/api/auth/me', { cookie })).status, 401)
  })
  const originalPassword = env.ADMIN_PASSWORD
  try {
    env.ADMIN_PASSWORD = 'changed-administrator-password'
    await atTime(initial.created_at + DAY / 2, async () => {
      const response = await call('/api/auth/me', { cookie })
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('set-cookie'), null)
      assert.equal(await sessionRecord(cookie), undefined)
    })
  } finally {
    env.ADMIN_PASSWORD = originalPassword
  }
})

test('failed, cross-site and mismatched-account requests do not renew sessions', async () => {
  const account = await renewalAccount('rejected_renewal')
  const initial = await sessionRecord(account.cookie)
  await atTime(initial.created_at + 6 * DAY, async () => {
    const cases = [
      ['/api/chats', { method: 'POST', body: {}, csrf: false }, 403],
      ['/api/auth/me', { headers: { 'X-Chat-User-ID': 'another-account' } }, 409],
      ['/api/admin/users', {}, 403],
      ['/api/chats/missing', {}, 404],
      ['/api/auth/me', { origin: 'https://evil.example' }, 200],
      ['/api/auth/me', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 200],
      ['/api/auth/me', { method: 'HEAD' }, 200],
    ]
    for (const [path, options, status] of cases) {
      const response = await call(path, { ...options, cookie: account.cookie })
      assert.equal(response.status, status)
      assert.equal(response.headers.get('set-cookie'), null)
      assert.equal((await sessionRecord(account.cookie)).expires_at, initial.expires_at)
    }
  })
})

test('logout or a password reset during renewal cannot recreate or extend revoked sessions', async () => {
  for (const change of ['logout', 'password']) {
    const account = await renewalAccount(`renewal_race_${change}`)
    const initial = await sessionRecord(account.cookie)
    const nearExpiry = Date.now() + DAY / 2
    db.db
      .prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(nearExpiry, initial.token_hash)
    const response = await beforeStatement(
      (sql) => sql.startsWith('UPDATE auth_sessions SET expires_at'),
      async () => {
        const revoked = await call(
          change === 'logout' ? '/api/auth/logout' : `/api/admin/users/${account.user.id}`,
          {
            method: change === 'logout' ? 'POST' : 'PATCH',
            cookie: change === 'logout' ? account.cookie : admin.cookie,
            ...(change === 'password' ? { body: { password: 'new-password-for-renewal' } } : {}),
          }
        )
        assert.equal(revoked.status, change === 'logout' ? 204 : 200)
      },
      () => call('/api/auth/me', { cookie: account.cookie })
    )
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(await sessionRecord(account.cookie), undefined)
  }
})

test('renewal database failures surface as errors without setting a cookie', async () => {
  const account = await renewalAccount('renewal_failure')
  const initial = await sessionRecord(account.cookie)
  db.db
    .prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?')
    .run(Date.now() + DAY / 2, initial.token_hash)
  db.beforeExecute = (sql) => {
    if (sql.startsWith('UPDATE auth_sessions SET expires_at')) {
      throw new Error('database unavailable')
    }
  }
  try {
    const response = await call('/api/auth/me', { cookie: account.cookie })
    assert.equal(response.status, 500)
    assert.equal(response.headers.get('set-cookie'), null)
  } finally {
    db.beforeExecute = undefined
  }
  assert.equal((await call('/api/auth/me', { cookie: account.cookie })).status, 200)
  assert.equal(
    (await sessionRecord(account.cookie)).absolute_expires_at,
    initial.absolute_expires_at
  )
})

test('a slower concurrent renewal cannot shorten a deadline already extended by another request', async () => {
  const account = await renewalAccount('concurrent_renewal')
  const initial = await sessionRecord(account.cookie)
  const renewalTime = initial.created_at + 6 * DAY
  await atTime(renewalTime, async () => {
    let second
    const first = await beforeStatement(
      (sql) => sql.startsWith('UPDATE auth_sessions SET expires_at'),
      async () => {
        Date.now = () => renewalTime + 1000
        second = await call('/api/auth/me', { cookie: account.cookie })
      },
      () => call('/api/chats', { cookie: account.cookie })
    )
    for (const response of [first, second]) {
      assert.equal(response.status, 200)
      assert.equal(cookieFrom(response), account.cookie)
      assert.match(response.headers.get('set-cookie'), /Max-Age=604800/)
    }
    assert.equal((await sessionRecord(account.cookie)).expires_at, renewalTime + 1000 + 7 * DAY)
  })
})

test('protected writes recheck credential versions and absolute expiration before committing', async () => {
  for (const change of ['version', 'absolute']) {
    const account = await renewalAccount(`write_guard_${change}`)
    const initial = await sessionRecord(account.cookie)
    db.beforeExecute = (sql) => {
      if (sql.includes('INSERT INTO chats')) {
        db.beforeExecute = undefined
        if (change === 'version') {
          db.db
            .prepare('UPDATE users SET password_hash = password_hash WHERE id = ?')
            .run(account.user.id)
        } else {
          db.db
            .prepare('UPDATE auth_sessions SET absolute_expires_at = ? WHERE token_hash = ?')
            .run(Date.now() - 1, initial.token_hash)
        }
      }
    }
    try {
      const response = await call('/api/chats/shared-id', {
        method: 'PUT',
        cookie: account.cookie,
        body: { session: session() },
      })
      assert.equal(response.status, 401)
      assert.equal(
        db.db.prepare('SELECT COUNT(*) AS n FROM chats WHERE user_id = ?').get(account.user.id).n,
        0
      )
    } finally {
      db.beforeExecute = undefined
    }
  }
})

test('streaming chat responses renew the application cookie without forwarding upstream cookies', async () => {
  const account = await renewalAccount('stream_renewal')
  const initial = await sessionRecord(account.cookie)
  await atTime(initial.created_at + 6 * DAY, async () => {
    const response = await call('/api/anthropic/v1/messages', {
      method: 'POST',
      cookie: account.cookie,
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'Hello' }] },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
    assert.equal(cookieFrom(response), account.cookie)
    assert.ok(!response.headers.get('set-cookie').includes('upstream-secret'))
    assert.match(await response.text(), /message_stop/)
    assert.equal((await sessionRecord(account.cookie)).expires_at, Date.now() + 7 * DAY)
  })
})

test('session migration revokes legacy tokens, preserves data and advances credential versions', () => {
  const legacy = new DatabaseSync(':memory:')
  try {
    legacy.exec(readFileSync('migrations/0001_initial.sql', 'utf8'))
    legacy.exec(readFileSync('migrations/0002_admin_password.sql', 'utf8'))
    legacy.exec(`
      INSERT INTO users (id, username, password_hash, role, status, created_at)
      VALUES ('legacy-user', 'legacy_user', 'hash', 'user', 'active', 1);
      INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
      VALUES ('legacy-token', 'legacy-user', 9999999999999, 1);
      INSERT INTO chats (user_id, id, title, created_at, updated_at, data_json)
      VALUES ('legacy-user', 'chat', 'History', 1, 1, '{}');
    `)
    legacy.exec(readFileSync('migrations/0003_session_renewal.sql', 'utf8'))
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0)
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM chats').get().n, 1)
    assert.equal(legacy.prepare('SELECT auth_version FROM users').get().auth_version, 1)
    legacy.prepare("UPDATE users SET password_hash = 'new-hash', status = 'disabled'").run()
    assert.equal(legacy.prepare('SELECT auth_version FROM users').get().auth_version, 2)
    legacy.prepare("UPDATE users SET status = 'active'").run()
    assert.equal(legacy.prepare('SELECT auth_version FROM users').get().auth_version, 3)
  } finally {
    legacy.close()
  }
})
