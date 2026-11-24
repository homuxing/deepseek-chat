import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { authRoutes, adminLoginRoutes, requireAuth, requireAdmin } from './auth.js'
import { dataRoutes, adminRoutes } from './data.js'
import { cleanupAbandonedStorage } from './cloudStorage.js'
import { proxyRoutes } from './proxy.js'
import type { AppEnv } from './types.js'
export { HistorySync } from './sync.js'

export const app = new Hono<AppEnv>()

const publicPaths = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/admin/login',
])

// Reject anonymous uploads before reading their bodies.
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  if (publicPaths.has(c.req.path)) {
    await next()
  } else {
    await requireAuth(c, next)
  }
})

app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (c.req.header('X-Requested-With') !== 'XMLHttpRequest') {
      throw new HTTPException(403, { message: '请求缺少防跨站校验头' })
    }
    const origin = c.req.header('Origin')
    const requestUrl = new URL(c.req.url)
    const allowedOrigin = c.env.APP_ORIGIN || requestUrl.origin
    const isLocal = requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1'
    const localOrigins = [
      'http://localhost:8090',
      'http://127.0.0.1:8090',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
    ]
    if (origin && origin !== allowedOrigin && !(isLocal && localOrigins.includes(origin))) {
      throw new HTTPException(403, { message: '不允许跨站请求' })
    }
  }
  await next()
})

app.use('/api/*', async (c, next) => {
  const fileUpload =
    c.req.method === 'POST' &&
    (/^\/api\/files\/[^/]+$/.test(c.req.path) || c.req.path === '/api/anthropic/v1/files')
  const multipartPart = /^\/api\/storage\/uploads\/[^/]+\/parts\/\d+$/.test(c.req.path)
  const size = multipartPart
    ? 10 * 1024 * 1024
    : fileUpload
      ? 65 * 1024 * 1024
      : c.req.path === '/api/v1/tools/asr'
        ? 9 * 1024 * 1024
        : 1024 * 1024
  if (multipartPart && c.req.method === 'PUT' && c.req.raw.body) {
    // 在大小检查入口识别连接中断，完整读取一个分片后才允许写入 R2。
    const reader = c.req.raw.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) {
          break
        }
        bytes += result.value.byteLength
        if (bytes > size) {
          await reader.cancel()
          return c.json({ error: { message: '请求数据过大' } }, 413)
        }
        chunks.push(result.value)
      }
    } catch {
      return c.json({ error: { message: '上传连接已中断' } }, 408)
    } finally {
      reader.releaseLock()
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    c.req.raw = new Request(c.req.raw, { body })
    await next()
    return
  }
  return bodyLimit({
    maxSize: size,
    onError: (ctx) => ctx.json({ error: { message: '请求数据过大' } }, 413),
  })(c, next)
})

app.route('/api/auth', authRoutes)
app.get('/api/sync', async (c) => {
  const user = c.get('user')
  // 浏览器的 WebSocket 无法自定义请求头，查询参数只用于核对页面所属账号。
  if (c.req.query('user') !== user.id) {
    throw new HTTPException(409, { message: '当前账号已变更' })
  }
  const headers = new Headers(c.req.raw.headers)
  headers.set('X-Sync-User', user.id)
  headers.set('X-Sync-Token', c.get('sessionTokenHash'))
  headers.set('X-Sync-Version', String(user.auth_version))
  return c.env.SYNC.get(c.env.SYNC.idFromName(user.id)).fetch(
    new Request('https://sync.internal/connect', { headers })
  )
})
app.route('/api/admin', adminLoginRoutes)

app.use('/api/admin/*', requireAdmin)
app.route('/api/admin', adminRoutes)
app.route('/api', dataRoutes)
app.route('/api', proxyRoutes)

app.all('/api', (c) => c.json({ error: { message: '接口不存在' } }, 404))
app.all('/api/*', (c) => c.json({ error: { message: '接口不存在' } }, 404))
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    if (
      error.status === 401 &&
      !['/api/auth/login', '/api/auth/register', '/api/admin/login'].includes(c.req.path)
    ) {
      c.header('X-Auth-Expired', '1')
    }
    return c.json({ error: { message: error.message } }, error.status)
  }
  // Keep database details and encrypted credentials out of public responses.
  return c.json({ error: { message: '服务器处理失败，请稍后重试' } }, 500)
})

const worker: ExportedHandler<AppEnv['Bindings']> = {
  fetch: app.fetch,
  async scheduled(_event, env) {
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        'DELETE FROM auth_sessions WHERE MIN(expires_at, absolute_expires_at) <= ?'
      ).bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE window_end <= ?').bind(now),
    ])
    await cleanupAbandonedStorage(env)
  },
}
// eslint-disable-next-line import/no-default-export
export default worker
