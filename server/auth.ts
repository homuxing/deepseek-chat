import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import {
  hashPassword,
  randomToken,
  sha256,
  verifyAccessIdentity,
  verifyPassword,
} from './security.js'
import type { AppEnv, UserRow } from './types.js'

const SESSION_COOKIE = 'private_chat_session'
const HANDOFF_COOKIE = 'private_chat_admin_handoff'
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000

export const publicUser = (user: UserRow) => ({
  id: user.id,
  username: user.username,
  role: user.role,
  status: user.status,
  hasCustomApiKey: Boolean(user.api_key_ciphertext),
  createdAt: user.created_at,
})

const sessionCookie = (c: Context<AppEnv>, token: string) =>
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DURATION / 1000,
  })

const createSession = async (c: Context<AppEnv>, userId: string): Promise<void> => {
  const token = randomToken()
  const now = Date.now()
  await c.env.DB.prepare(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(await sha256(token), userId, now + SESSION_DURATION, now)
    .run()
  sessionCookie(c, token)
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  const tokenHash = token ? await sha256(token) : ''
  const user = token
    ? await c.env.DB.prepare(
        'SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = ?'
      )
        .bind(tokenHash, Date.now(), 'active')
        .first<UserRow>()
    : null
  if (!user) {
    throw new HTTPException(401, { message: '请先登录，或登录状态已过期' })
  }
  const expectedUser = c.req.header('X-Chat-User-ID')
  if (expectedUser && expectedUser !== user.id) {
    c.header('X-Auth-Expired', '1')
    throw new HTTPException(409, { message: '当前账户已在其他页面切换，请刷新后继续' })
  }
  if (
    user.role === 'admin' &&
    !c.env.ADMIN_EMAILS?.split(',').some(
      (email) => email.trim().toLowerCase() === user.username.toLowerCase()
    )
  ) {
    throw new HTTPException(403, { message: '管理员身份已从部署白名单中移除' })
  }
  c.set('user', user)
  c.set('sessionTokenHash', tokenHash)
  await next()
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') {
    throw new HTTPException(403, { message: '需要管理员权限' })
  }
  await next()
}

export const jsonBody = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await c.req.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Expected object')
    }
    return value as Record<string, unknown>
  } catch {
    throw new HTTPException(400, { message: '无效的 JSON 请求' })
  }
}

export const validatePassword = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw new HTTPException(400, { message: '密码长度须为 10–128 个字符' })
  }
  return value
}

const usernameInput = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(value)) {
    throw new HTTPException(400, { message: '用户名须为 3–32 位字母、数字、下划线或短横线' })
  }
  return value.toLowerCase()
}

// Persistent per-IP limits also work across isolates. A successful login does not reset the quota.
export const rateLimit = async (
  c: Context<AppEnv>,
  scope: string,
  limit: number,
  duration = 15 * 60 * 1000
): Promise<void> => {
  const key = `${scope}:${c.req.header('CF-Connecting-IP') ?? 'local'}`
  const now = Date.now()
  const result = await c.env.DB.prepare(
    'INSERT INTO rate_limits (key, attempts, window_end) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN window_end <= ? THEN 1 ELSE attempts + 1 END, window_end = CASE WHEN window_end <= ? THEN excluded.window_end ELSE window_end END RETURNING attempts'
  )
    .bind(key, now + duration, now, now)
    .first<{ attempts: number }>()
  if (!result || result.attempts > limit) {
    c.header('Retry-After', String(Math.ceil(duration / 1000)))
    throw new HTTPException(429, { message: '请求过于频繁，请稍后再试' })
  }
}

export const authRoutes = new Hono<AppEnv>()

authRoutes.post('/register', async (c) => {
  await rateLimit(c, 'register', 10)
  const body = await jsonBody(c)
  const username = usernameInput(body.username)
  const password = validatePassword(body.password)
  if (
    typeof body.inviteCode !== 'string' ||
    body.inviteCode.trim().length > 128 ||
    !body.inviteCode.trim()
  ) {
    throw new HTTPException(400, { message: '请输入有效的邀请码' })
  }
  const now = Date.now()
  const id = crypto.randomUUID()
  const token = randomToken()
  const passwordHash = await hashPassword(password)
  let result: D1Result[]
  try {
    result = await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE invites SET uses = uses + 1 WHERE code_hash = ? AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)'
      ).bind(await sha256(body.inviteCode.trim()), now),
      c.env.DB.prepare(
        "INSERT INTO users (id, username, password_hash, role, status, created_at) SELECT ?, ?, ?, 'user', 'active', ? WHERE changes() = 1"
      ).bind(id, username, passwordHash, now),
      c.env.DB.prepare(
        'INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)'
      ).bind(await sha256(token), id, now + SESSION_DURATION, now, id),
    ])
  } catch {
    throw new HTTPException(409, { message: '注册失败，用户名可能已被使用' })
  }
  if (result[1].meta.changes !== 1) {
    throw new HTTPException(400, { message: '邀请码无效、已用完或已过期' })
  }
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()
  if (!user) {
    throw new HTTPException(500, { message: '注册失败' })
  }
  sessionCookie(c, token)
  return c.json({ user: publicUser(user) }, 201)
})

authRoutes.post('/login', async (c) => {
  await rateLimit(c, 'login', 20)
  const body = await jsonBody(c)
  const username = usernameInput(body.username)
  const password = validatePassword(body.password)
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username = ? AND role = 'user'")
    .bind(username)
    .first<UserRow>()
  // Always derive a hash so nonexistent accounts and wrong passwords have similar cost.
  const valid = await verifyPassword(
    password,
    user?.password_hash ??
      'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
  )
  if (!user || user.status !== 'active' || !valid) {
    throw new HTTPException(401, { message: '用户名或密码错误，或账户已停用' })
  }
  await createSession(c, user.id)
  return c.json({ user: publicUser(user) })
})

authRoutes.use('/me', requireAuth)
authRoutes.get('/me', (c) => c.json({ user: publicUser(c.get('user')) }))

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await c.env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .bind(await sha256(token))
      .run()
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.body(null, 204)
})

export const adminLoginRoutes = new Hono<AppEnv>()

adminLoginRoutes.get('/access', async (c) => {
  const identity = await verifyAccessIdentity(
    c.req.header('Cf-Access-Jwt-Assertion') ?? getCookie(c, 'CF_Authorization'),
    c.env
  )
  const now = Date.now()
  await c.env.DB.prepare(
    "INSERT INTO users (id, username, access_sub, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?) ON CONFLICT(access_sub) DO UPDATE SET username = excluded.username"
  )
    .bind(crypto.randomUUID(), identity.email, identity.sub, now)
    .run()
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE access_sub = ?')
    .bind(identity.sub)
    .first<UserRow>()
  if (!user || user.status !== 'active') {
    throw new HTTPException(403, { message: '管理员账户已停用' })
  }
  const handoff = randomToken()
  await c.env.DB.prepare(
    'INSERT INTO login_handoffs (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(await sha256(handoff), user.id, now + 120_000)
    .run()
  setCookie(c, HANDOFF_COOKIE, handoff, {
    path: '/api/admin',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: 120,
  })
  return c.redirect('/api/admin/access/callback', 303)
})

adminLoginRoutes.post('/login', async (c) => {
  const handoff = getCookie(c, HANDOFF_COOKIE)
  deleteCookie(c, HANDOFF_COOKIE, { path: '/api/admin' })
  if (!handoff) {
    throw new HTTPException(401, { message: '请重新通过 Cloudflare Access 登录' })
  }
  const row = await c.env.DB.prepare(
    'DELETE FROM login_handoffs WHERE token_hash = ? AND expires_at > ? RETURNING user_id'
  )
    .bind(await sha256(handoff), Date.now())
    .first<{ user_id: string }>()
  const user = row
    ? await c.env.DB.prepare(
        "SELECT * FROM users WHERE id = ? AND role = 'admin' AND status = 'active'"
      )
        .bind(row.user_id)
        .first<UserRow>()
    : null
  if (!user) {
    throw new HTTPException(401, { message: '管理员登录凭据已过期' })
  }
  await createSession(c, user.id)
  return c.json({ user: publicUser(user) })
})
