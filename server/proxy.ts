import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { decryptApiKey, sha256 } from './security.js'
import { jsonBody, rateLimit } from './auth.js'
import type { AppEnv } from './types.js'

const upstreamOrigin = (c: Context<AppEnv>): string => {
  const url = new URL(c.env.DEEPSEEK_API_ORIGIN || 'https://api.deepseek.com')
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw new HTTPException(503, { message: 'DEEPSEEK_API_ORIGIN 必须是 HTTPS 服务源地址' })
  }
  return url.origin
}

const selectedApiKey = async (c: Context<AppEnv>): Promise<string> => {
  const encrypted = c.get('user').api_key_ciphertext
  const key = encrypted
    ? await decryptApiKey(encrypted, c.env.API_KEY_ENCRYPTION_KEY)
    : c.env.DEEPSEEK_API_KEY
  if (!key) {
    throw new HTTPException(503, {
      message: '服务尚未配置 API Key，请联系管理员或在数据管理中设置自定义 API Key',
    })
  }
  return key
}

const upstreamHeaders = (key: string, contentType?: string): Headers => {
  const headers = new Headers({ Authorization: `Bearer ${key}`, 'x-api-key': key })
  if (contentType) {
    headers.set('Content-Type', contentType)
  }
  return headers
}

const upstreamFetch = async (
  c: Context<AppEnv>,
  path: string,
  init: RequestInit
): Promise<Response> => {
  try {
    return await fetch(`${upstreamOrigin(c)}${path}`, {
      ...init,
      redirect: 'manual',
      signal: c.req.raw.signal,
    })
  } catch {
    throw new HTTPException(502, { message: '无法连接 DeepSeek 服务，请稍后重试' })
  }
}

// Forward only protocol headers, never upstream cookies or credentials. Passing the body preserves SSE and audio streaming.
const forwarded = (response: Response): Response => {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  for (const name of ['Content-Type', 'Retry-After', 'request-id', 'x-request-id']) {
    const value = response.headers.get(name)
    if (value) {
      headers.set(name, value)
    }
  }
  if (response.status >= 300 && response.status < 400) {
    return Response.json(
      { error: { message: '上游返回了非预期的重定向' } },
      { status: 502, headers }
    )
  }
  return new Response(response.body, { status: response.status, headers })
}

const collectFileIds = (value: unknown, ids: Set<string>, depth = 0): void => {
  if (depth > 40) {
    throw new HTTPException(400, { message: '请求结构过深' })
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectFileIds(item, ids, depth + 1))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'file_id') {
        if (typeof item !== 'string' || item.length > 200) {
          throw new HTTPException(400, { message: '无效的附件 ID' })
        }
        ids.add(item)
      } else {
        collectFileIds(item, ids, depth + 1)
      }
    }
  }
}

const assertFileOwnership = async (
  c: Context<AppEnv>,
  fileIds: Set<string>,
  key: string
): Promise<void> => {
  const hash = await sha256(key)
  for (const id of fileIds) {
    const file = await c.env.DB.prepare(
      'SELECT id FROM api_files WHERE user_id = ? AND id = ? AND credential_hash = ?'
    )
      .bind(c.get('user').id, id, hash)
      .first()
    if (!file) {
      // Matches the existing client retry path; it can upload its own original with the newly selected credential.
      throw new HTTPException(400, {
        message: `file_ids do not exist or are not created under your account: ${id}`,
      })
    }
  }
}

export const proxyRoutes = new Hono<AppEnv>()

proxyRoutes.post('/settings/api-key/verify', async (c) => {
  await rateLimit(c, `verify-key:${c.get('user').id}`, 20)
  const body = await jsonBody(c)
  if (
    typeof body.apiKey !== 'string' ||
    !body.apiKey.trim() ||
    body.apiKey.length > 512 ||
    /[\r\n]/.test(body.apiKey)
  ) {
    throw new HTTPException(400, { message: '请输入有效的自定义 API Key' })
  }
  return forwarded(
    await upstreamFetch(c, '/models', { headers: upstreamHeaders(body.apiKey.trim()) })
  )
})

proxyRoutes.get('/models', async (c) =>
  forwarded(
    await upstreamFetch(c, '/models', { headers: upstreamHeaders(await selectedApiKey(c)) })
  )
)

proxyRoutes.post('/anthropic/v1/messages', async (c) => {
  await rateLimit(c, `chat:${c.get('user').id}`, 60, 60_000)
  const body = await jsonBody(c)
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > 2000 ||
    typeof body.model !== 'string'
  ) {
    throw new HTTPException(400, { message: '无效的聊天请求' })
  }
  const key = await selectedApiKey(c)
  const ids = new Set<string>()
  collectFileIds(body, ids)
  await assertFileOwnership(c, ids, key)
  const headers = upstreamHeaders(key, 'application/json')
  headers.set('Accept', 'text/event-stream')
  if (ids.size) {
    headers.set('anthropic-beta', 'files-api-2025-04-14')
  }
  return forwarded(
    await upstreamFetch(c, '/anthropic/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
    })
  )
})

proxyRoutes.post('/anthropic/v1/files', async (c) => {
  await rateLimit(c, `upload:${c.get('user').id}`, 120, 60 * 60_000)
  const key = await selectedApiKey(c)
  const contentType = c.req.header('Content-Type')
  if (!contentType?.startsWith('multipart/form-data;')) {
    throw new HTTPException(400, { message: '上传文件须使用 multipart/form-data' })
  }
  const headers = upstreamHeaders(key, contentType)
  headers.set('anthropic-beta', 'files-api-2025-04-14')
  const response = await upstreamFetch(c, '/anthropic/v1/files', {
    method: 'POST',
    headers,
    body: c.req.raw.body,
  })
  if (!response.ok) {
    return forwarded(response)
  }
  const file: unknown = await response.json()
  if (
    typeof file !== 'object' ||
    file === null ||
    !('id' in file) ||
    typeof file.id !== 'string' ||
    file.id.length > 200
  ) {
    throw new HTTPException(502, { message: 'DeepSeek 上传响应格式无效' })
  }
  await c.env.DB.prepare(
    'INSERT INTO api_files (user_id, id, credential_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET credential_hash = excluded.credential_hash'
  )
    .bind(c.get('user').id, file.id, await sha256(key), Date.now())
    .run()
  return c.json(file)
})

proxyRoutes.delete('/anthropic/v1/files/:id', async (c) => {
  const key = await selectedApiKey(c)
  const id = c.req.param('id')
  await assertFileOwnership(c, new Set([id]), key)
  const headers = upstreamHeaders(key)
  headers.set('anthropic-beta', 'files-api-2025-04-14')
  const response = await upstreamFetch(c, `/anthropic/v1/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
  })
  if (response.ok || response.status === 404) {
    await c.env.DB.prepare('DELETE FROM api_files WHERE user_id = ? AND id = ?')
      .bind(c.get('user').id, id)
      .run()
  }
  return forwarded(response)
})

for (const tool of ['asr', 'tts']) {
  proxyRoutes.post(`/v1/tools/${tool}`, async (c) => {
    await rateLimit(c, `speech:${c.get('user').id}`, 60, 60_000)
    return forwarded(
      await upstreamFetch(c, `/v1/tools/${tool}`, {
        method: 'POST',
        headers: upstreamHeaders(await selectedApiKey(c), c.req.header('Content-Type')),
        body: c.req.raw.body,
      })
    )
  })
}
