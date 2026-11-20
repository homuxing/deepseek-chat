import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import {
  hashPassword,
  adminCredentialHash,
  equalSecret,
  randomToken,
  sha256,
  verifyPassword,
} from './security.js'
import type { AppEnv, Bindings, UserRow } from './types.js'

const SESSION_COOKIE = 'deepseek_chat_session'
const SUPER_ADMIN_ID = 'deepseek-super-admin'
const DAY = 24 * 60 * 60 * 1000
const sessionPolicy = (role: UserRow['role']) =>
  role === 'admin'
    ? { duration: DAY, renewalWindow: DAY / 4, absoluteDuration: 7 * DAY }
    : { duration: 7 * DAY, renewalWindow: DAY, absoluteDuration: 30 * DAY }

type AuthenticatedSession = UserRow & {
  admin_credential_hash: string | null
  session_expires_at: number
  absolute_expires_at: number
}

export const publicUser = (user: UserRow) => ({
  id: user.id,
  username: user.username,
  role: user.role,
  status: user.status,
  hasCustomApiKey: Boolean(user.api_key_ciphertext),
  createdAt: user.created_at,
})

const sessionCookie = (c: Context<AppEnv>, token: string, expiresAt: number) =>
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
    expires: new Date(expiresAt),
  })

const createSession = async (
  c: Context<AppEnv>,
  user: UserRow,
  credentialHash: string | null = null
): Promise<void> => {
  const token = randomToken()
  const now = Date.now()
  const policy = sessionPolicy(user.role)
  const expiresAt = now + policy.duration
  // 在同一条 SQL 中检查校验密码时的版本及凭据，避免重置后插入旧凭据会话。
  const result = await c.env.DB.prepare(
    `INSERT INTO auth_sessions
       (token_hash, user_id, expires_at, created_at, admin_credential_hash, auth_version, absolute_expires_at)
     SELECT ?, id, ?, ?, ?, auth_version, ? FROM users
     WHERE id = ? AND username = ? AND role = ? AND status = 'active'
       AND auth_version = ? AND password_hash IS ?`
  )
    .bind(
      await sha256(token),
      expiresAt,
      now,
      credentialHash,
      now + policy.absoluteDuration,
      user.id,
      user.username,
      user.role,
      user.auth_version,
      user.password_hash
    )
    .run()
  if (result.meta.changes !== 1) {
    throw new HTTPException(401, { message: '账户凭据或状态已变更，请重新登录' })
  }
  sessionCookie(c, token, expiresAt)
}

const adminCredentials = (env: Bindings) => {
  if (typeof env.ADMIN_USERNAME !== 'string' || !env.ADMIN_USERNAME.trim()) {
    throw new HTTPException(503, {
      message: '当前 Worker 未读取到 ADMIN_USERNAME，请在生产环境的运行时变量中配置并点击部署',
    })
  }
  const username = env.ADMIN_USERNAME.trim().toLowerCase()
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
    throw new HTTPException(503, {
      message: 'ADMIN_USERNAME 配置无效，须为 3–32 位字母、数字、下划线或短横线',
    })
  }
  const password = env.ADMIN_PASSWORD
  if (typeof password !== 'string' || !password) {
    throw new HTTPException(503, {
      message: '当前 Worker 未读取到 ADMIN_PASSWORD，请在生产环境的运行时密钥中配置并点击部署',
    })
  }
  if (password.length < 10 || password.length > 128) {
    throw new HTTPException(503, {
      message: 'ADMIN_PASSWORD 配置无效，须为 10–128 个字符；请修改运行时密钥后点击部署',
    })
  }
  return { username, password }
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  const tokenHash = token ? await sha256(token) : ''
  const now = Date.now()
  const user = token
    ? await c.env.DB.prepare(
        `SELECT u.*, s.admin_credential_hash, s.expires_at AS session_expires_at, s.absolute_expires_at
         FROM users u JOIN auth_sessions s ON s.user_id = u.id
         WHERE s.token_hash = ? AND s.expires_at > ? AND s.absolute_expires_at > ?
           AND s.auth_version = u.auth_version AND u.status = 'active'`
      )
        .bind(tokenHash, now, now)
        .first<AuthenticatedSession>()
    : null
  if (!user) {
    throw new HTTPException(401, { message: '请先登录，或登录状态已过期' })
  }
  const expectedUser = c.req.header('X-Chat-User-ID')
  if (expectedUser && expectedUser !== user.id) {
    c.header('X-Auth-Expired', '1')
    throw new HTTPException(409, { message: '当前账户已在其他页面切换，请刷新后继续' })
  }
  if (user.role === 'admin') {
    let valid = false
    try {
      const credentials = adminCredentials(c.env)
      valid =
        user.id === SUPER_ADMIN_ID &&
        user.username === credentials.username &&
        equalSecret(
          user.admin_credential_hash ?? '',
          await adminCredentialHash(credentials.username, credentials.password)
        )
    } catch {
      valid = false
    }
    if (!valid) {
      await c.env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run()
      throw new HTTPException(401, { message: '管理员配置已变更，请重新登录' })
    }
  }
  c.set('user', user)
  c.set('sessionTokenHash', tokenHash)
  await next()

  const policy = sessionPolicy(user.role)
  const origin = c.req.header('Origin')
  // 仅成功的站内业务请求触发续期，跨站请求、失败响应和退出均不会延长会话。
  if (
    !token ||
    c.res.status < 200 ||
    c.res.status >= 300 ||
    ['HEAD', 'OPTIONS'].includes(c.req.method) ||
    c.req.header('Sec-Fetch-Site') === 'cross-site' ||
    (origin && origin !== (c.env.APP_ORIGIN || new URL(c.req.url).origin)) ||
    user.session_expires_at - now > policy.renewalWindow ||
    user.session_expires_at >= user.absolute_expires_at
  ) {
    return
  }
  const renewalTime = Date.now()
  // UPDATE 保留同一个 token，并重新检查撤销、过期及凭据版本；并发续期不会缩短期限。
  const renewed = await c.env.DB.prepare(
    `UPDATE auth_sessions SET expires_at = MAX(expires_at, MIN(?, absolute_expires_at))
     WHERE token_hash = ? AND expires_at > ? AND absolute_expires_at > ?
       AND auth_version = ? AND EXISTS (
         SELECT 1 FROM users u WHERE u.id = auth_sessions.user_id
           AND u.auth_version = auth_sessions.auth_version AND u.status = 'active'
       )
     RETURNING expires_at`
  )
    .bind(renewalTime + policy.duration, tokenHash, renewalTime, renewalTime, user.auth_version)
    .first<{ expires_at: number }>()
  if (!renewed) {
    throw new HTTPException(401, { message: '登录状态已变更或过期，请重新登录' })
  }
  sessionCookie(c, token, renewed.expires_at)
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
  if (username === c.env.ADMIN_USERNAME?.trim().toLowerCase()) {
    throw new HTTPException(409, { message: '该用户名不可注册' })
  }
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
  const policy = sessionPolicy('user')
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
        `INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at, auth_version, absolute_expires_at)
         SELECT ?, id, ?, ?, auth_version, ? FROM users WHERE id = ?`
      ).bind(await sha256(token), now + policy.duration, now, now + policy.absoluteDuration, id),
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
  sessionCookie(c, token, now + policy.duration)
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
  await createSession(c, user)
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

adminLoginRoutes.post('/login', async (c) => {
  await rateLimit(c, 'admin-login', 10)
  const body = await jsonBody(c)
  const username = usernameInput(body.username)
  const password = validatePassword(body.password)
  const credentials = adminCredentials(c.env)
  const credentialHash = await adminCredentialHash(credentials.username, credentials.password)
  const valid = equalSecret(
    await adminCredentialHash(credentials.username, password),
    credentialHash
  )
  if (username !== credentials.username || !valid) {
    throw new HTTPException(401, { message: '用户名或密码错误' })
  }

  // Keep one stable administrator identity; never promote an existing normal user.
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, username, role, status, created_at) VALUES (?, ?, 'admin', 'active', ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username WHERE users.role = 'admin'"
    )
      .bind(SUPER_ADMIN_ID, credentials.username, Date.now())
      .run()
  } catch {
    throw new HTTPException(409, { message: '管理员用户名已被其他账户使用，请更换 ADMIN_USERNAME' })
  }
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(SUPER_ADMIN_ID)
    .first<UserRow>()
  if (
    !user ||
    user.role !== 'admin' ||
    user.status !== 'active' ||
    user.username !== credentials.username
  ) {
    throw new HTTPException(403, { message: '管理员账户不可用' })
  }
  await c.env.DB.prepare(
    'DELETE FROM auth_sessions WHERE user_id = ? AND (admin_credential_hash IS NULL OR admin_credential_hash != ?)'
  )
    .bind(user.id, credentialHash)
    .run()
  await createSession(c, user, credentialHash)
  return c.json({ user: publicUser(user) })
})
