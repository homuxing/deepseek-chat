import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  assertApiKeyEncryptionConfigured,
  encryptApiKey,
  hashPassword,
  randomToken,
  sha256,
  validateCustomApiKey,
} from './security.js'
import { rateLimit } from './auth.js'
import { verifyCustomApiKey } from './proxy.js'
import {
  clearCloudChats,
  cloudStorageRoutes,
  deleteActiveChat,
  deleteUnreferencedFilesBestEffort,
  ensureActiveHistory,
  listActiveChats,
  loadActiveChat,
  notifyHistoryChange,
  publishChatUpload,
  renameActiveChat,
  resolveExpectedHistory,
  saveChatSession,
} from './cloudStorage.js'
import type { AppEnv } from './types.js'

const MAX_ID_LENGTH = 128
const MAX_MIME_TYPE_LENGTH = 255
const R2_DELETE_BATCH_SIZE = 500
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Recheck inside the write statement, since administrator cleanup may revoke a session during an upload.
const liveSessionSql = `EXISTS (
  SELECT 1 FROM auth_sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.user_id = ? AND MIN(s.expires_at, s.absolute_expires_at) > ?
    AND s.auth_version = u.auth_version AND u.status = 'active'
)`

type JsonRecord = Record<string, unknown>

type Session = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: unknown[]
  rootMessageId?: string | null
}

type FileRow = {
  r2_key: string
  mime_type: string
  size: number
}

type FileKeyRow = {
  r2_key: string
}

type AdminUserRow = {
  id: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  createdAt: number
  api_key_ciphertext: string | null
  session_count: number
}

type InviteRow = {
  id: string
  code_hash: string
  max_uses: number
  uses: number
  expires_at: number | null
  created_by: string
  created_at: number
}

type ValidatedSession = Session & JsonRecord

type InviteView = {
  id: string
  code: string | null
  maxUses: number
  uses: number
  expiresAt: number | null
  createdBy: string
  createdAt: number
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isValidId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH &&
  SAFE_IDENTIFIER.test(value)

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

const errorResponse = (message: string, status = 400): Response =>
  jsonResponse({ error: { message } }, status)

const noContent = (): Response => new Response(null, { status: 204 })

const readJson = async (request: Request): Promise<unknown> => {
  const text = await request.text()
  if (text.length === 0) {
    throw new SyntaxError('Request body is required')
  }
  return JSON.parse(text) as unknown
}

const isMessage = (value: unknown): boolean => {
  if (!isRecord(value) || !isValidId(value.id) || !isTimestamp(value.createdAt)) {
    return false
  }
  if (
    (value.parentId !== undefined && value.parentId !== null && !isValidId(value.parentId)) ||
    (value.selectedChildId !== undefined && !isValidId(value.selectedChildId))
  ) {
    return false
  }
  if (value.role === 'user') {
    return (
      typeof value.content === 'string' &&
      Array.isArray(value.files) &&
      value.files.every(
        (file) =>
          isRecord(file) &&
          isValidId(file.id) &&
          (file.serverId === null || isValidId(file.serverId)) &&
          typeof file.name === 'string' &&
          typeof file.size === 'number' &&
          Number.isFinite(file.size) &&
          file.size >= 0 &&
          typeof file.isImage === 'boolean' &&
          typeof file.mimeType === 'string'
      )
    )
  }
  return (
    value.role === 'assistant' &&
    Array.isArray(value.blocks) &&
    typeof value.prefix === 'boolean' &&
    typeof value.status === 'string'
  )
}

const validateSession = (value: unknown): ValidatedSession | null => {
  if (!isRecord(value)) {
    return null
  }
  if (
    !isValidId(value.id) ||
    typeof value.title !== 'string' ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage)
  ) {
    return null
  }
  if (
    value.rootMessageId !== undefined &&
    value.rootMessageId !== null &&
    !isValidId(value.rootMessageId)
  ) {
    return null
  }
  if (value.pinned !== undefined && typeof value.pinned !== 'boolean') {
    return null
  }
  return value as ValidatedSession
}

const inviteView = (row: InviteRow, code: string | null): InviteView => ({
  id: row.id,
  code,
  maxUses: row.max_uses,
  uses: row.uses,
  expiresAt: row.expires_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
})

const adminUserView = (row: AdminUserRow) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  status: row.status,
  createdAt: row.createdAt,
  sessionCount: Number(row.session_count),
  hasCustomApiKey: row.api_key_ciphertext !== null,
})

const deleteR2Keys = async (env: AppEnv['Bindings'], keys: string[]): Promise<void> => {
  for (let offset = 0; offset < keys.length; offset += R2_DELETE_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + R2_DELETE_BATCH_SIZE)
    if (batch.length > 0) {
      await env.FILES.delete(batch)
    }
  }
}

const isScopedR2Key = (key: string, userId: string): boolean => {
  const prefix = `${userId}/`
  if (!key.startsWith(prefix) || key.length === prefix.length) {
    return false
  }
  return key
    .slice(prefix.length)
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..')
}

export const cleanupUserFiles = async (env: AppEnv['Bindings'], userId: string): Promise<void> => {
  await clearCloudChats(env, userId, true)
}

const clearUserChats = async (
  env: AppEnv['Bindings'],
  userId: string,
  revokeSessions = false,
  sessionTokenHash?: string
): Promise<void> => {
  await clearCloudChats(env, userId, revokeSessions, sessionTokenHash)
  await notifyHistoryChange(env, userId)
}

export const dataRoutes = new Hono<AppEnv>()
dataRoutes.route('/', cloudStorageRoutes)

dataRoutes.get('/chats', async (c) => {
  const user = c.get('user')
  return jsonResponse(await listActiveChats(c.env, user.id))
})

dataRoutes.get('/chats/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid chat id')
  }
  const loaded = await loadActiveChat(c.env, user.id, id)
  if (loaded.kind === 'not_found') {
    return errorResponse('会话不存在', 404)
  }
  if (loaded.kind === 'invalid') {
    return errorResponse(loaded.message, 500)
  }
  return jsonResponse({ session: loaded.session, summary: loaded.summary })
})

const saveChatRoute = async (c: Context<AppEnv>): Promise<Response> => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (id === 'import') {
    return legacyImportRoute(c)
  }
  if (!isValidId(id)) {
    return errorResponse('Invalid chat id')
  }

  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('Invalid JSON body')
  }
  if (!isRecord(body)) {
    return errorResponse('请求内容无效')
  }

  if ('uploadId' in body) {
    if (!isValidId(body.uploadId)) {
      return errorResponse('上传任务 ID 无效')
    }
    return publishChatUpload(c.env, user, body.uploadId)
  }

  if (!('session' in body)) {
    return errorResponse('session 或 uploadId 必须提供')
  }
  const session = validateSession(body.session)
  if (!session || session.id !== id) {
    return errorResponse('Invalid session')
  }

  const active = await ensureActiveHistory(c.env, user.id)
  const existing = await c.env.DB.prepare(
    `SELECT revision FROM chats
     WHERE user_id = ? AND generation = ? AND id = ?`
  )
    .bind(user.id, active.generation, id)
    .first<{ revision: number }>()
  const expected = resolveExpectedHistory(
    body,
    new Headers(c.req.raw.headers),
    active,
    existing?.revision ?? 0
  )
  if (!expected) {
    return errorResponse('generation 或 expectedRevision 无效')
  }
  const saved = await saveChatSession(c.env, user, c.get('sessionTokenHash'), session, expected)
  if (saved.kind === 'unauthorized') {
    throw new HTTPException(401, { message: saved.message })
  }
  if (saved.kind === 'conflict') {
    return errorResponse(saved.message, 409)
  }
  await notifyHistoryChange(c.env, user.id)
  const hasExpectedVersion =
    body.generation !== undefined ||
    body.expectedRevision !== undefined ||
    c.req.header('X-Chat-Generation') !== undefined ||
    c.req.header('X-Chat-Revision') !== undefined
  return hasExpectedVersion
    ? jsonResponse({
        summary: saved.summary,
        generation: saved.summary.generation,
        revision: saved.summary.revision,
      })
    : noContent()
}

dataRoutes.put('/chats/:id', saveChatRoute)
dataRoutes.post('/chats/:id', saveChatRoute)

dataRoutes.patch('/chats/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid chat id')
  }

  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('Invalid JSON body')
  }
  if (!isRecord(body) || typeof body.title !== 'string') {
    return errorResponse('Invalid title')
  }
  const active = await ensureActiveHistory(c.env, user.id)
  const existing = await c.env.DB.prepare(
    `SELECT revision FROM chats
     WHERE user_id = ? AND generation = ? AND id = ?`
  )
    .bind(user.id, active.generation, id)
    .first<{ revision: number }>()
  const expected = resolveExpectedHistory(
    body,
    new Headers(c.req.raw.headers),
    active,
    existing?.revision ?? 0
  )
  if (!expected) {
    return errorResponse('generation 或 expectedRevision 无效')
  }
  const renamed = await renameActiveChat(
    c.env,
    user,
    c.get('sessionTokenHash'),
    id,
    body.title,
    expected
  )
  if (renamed.kind === 'unauthorized') {
    throw new HTTPException(401, { message: renamed.message })
  }
  if (renamed.kind === 'conflict') {
    return errorResponse(renamed.message, 409)
  }
  if (renamed.kind === 'not_found') {
    return errorResponse('会话不存在', 404)
  }
  await notifyHistoryChange(c.env, user.id)
  const hasVersion =
    c.req.header('X-Chat-Revision') !== undefined || body.expectedRevision !== undefined
  if (hasVersion) {
    const history = await ensureActiveHistory(c.env, user.id)
    return jsonResponse({ summary: renamed.summary, ...history })
  }
  return noContent()
})

dataRoutes.delete('/chats/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid chat id')
  }
  const active = await ensureActiveHistory(c.env, user.id)
  const existing = await c.env.DB.prepare(
    `SELECT revision FROM chats
     WHERE user_id = ? AND generation = ? AND id = ?`
  )
    .bind(user.id, active.generation, id)
    .first<{ revision: number }>()
  const expected = resolveExpectedHistory(
    {},
    new Headers(c.req.raw.headers),
    active,
    existing?.revision ?? 0
  )
  if (!expected) {
    return errorResponse('X-Chat-Generation 或 X-Chat-Revision 无效')
  }
  const deleted = await deleteActiveChat(c.env, user, c.get('sessionTokenHash'), id, expected)
  if (deleted.kind === 'unauthorized') {
    throw new HTTPException(401, { message: deleted.message })
  }
  if (deleted.kind === 'conflict') {
    return errorResponse(deleted.message, 409)
  }
  if (deleted.kind === 'not_found') {
    return errorResponse('会话不存在', 404)
  }
  await notifyHistoryChange(c.env, user.id)
  return noContent()
})

dataRoutes.delete('/chats', async (c) => {
  const user = c.get('user')
  await clearUserChats(c.env, user.id, false, c.get('sessionTokenHash'))
  return noContent()
})

async function legacyImportRoute(c: Context<AppEnv>): Promise<Response> {
  const user = c.get('user')
  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('Invalid JSON body')
  }
  if (!isRecord(body) || !Array.isArray(body.sessions)) {
    return errorResponse('sessions must be an array')
  }

  const sessions: ValidatedSession[] = []
  const ids = new Set<string>()
  for (const candidate of body.sessions) {
    const session = validateSession(candidate)
    if (!session) {
      return errorResponse('Invalid session')
    }
    if (ids.has(session.id)) {
      return errorResponse('Duplicate session id')
    }
    ids.add(session.id)
    sessions.push(session)
  }

  const active = await ensureActiveHistory(c.env, user.id)
  const importId = crypto.randomUUID()
  const generation = `legacy_import_${crypto.randomUUID().replaceAll('-', '')}`
  const metadata = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    pinned: session.pinned === true ? 1 : 0,
    bodyKey: `${user.id}/chats/${generation}/${session.id}/${crypto.randomUUID()}`,
  }))
  const referenceRows = sessions.map((session) => {
    const fileIds = new Set<string>()
    for (const message of session.messages as unknown[]) {
      if (!isRecord(message) || !Array.isArray(message.files)) {
        continue
      }
      for (const file of message.files) {
        if (isRecord(file) && isValidId(file.id)) {
          fileIds.add(file.id)
        }
      }
    }
    return { chatId: session.id, fileIds: [...fileIds] }
  })
  const keys = metadata.map((item) => item.bodyKey)
  try {
    await Promise.all(
      sessions.map((session, index) =>
        c.env.FILES.put(keys[index], JSON.stringify(session), {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
        })
      )
    )
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO cloud_imports
           (user_id, id, generation, base_revision, status, count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'staging', ?, ?, ?)`
      ).bind(
        user.id,
        importId,
        generation,
        active.revision,
        sessions.length,
        Date.now(),
        Date.now()
      ),
      c.env.DB.prepare(
        `INSERT INTO chats
           (user_id, generation, id, revision, title, pinned,
            created_at, updated_at, data_json, body_key)
         SELECT ?, ?, json_extract(value, '$.id'), ?, json_extract(value, '$.title'),
                json_extract(value, '$.pinned'),
                json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt'), '{}',
                json_extract(value, '$.bodyKey')
         FROM json_each(?)`
      ).bind(user.id, generation, active.revision, JSON.stringify(metadata)),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO chat_files (user_id, generation, chat_id, file_id)
         SELECT ?, ?, json_extract(chat.value, '$.chatId'), file.value
         FROM json_each(?) chat
         JOIN json_each(chat.value, '$.fileIds') file`
      ).bind(user.id, generation, JSON.stringify(referenceRows)),
      c.env.DB.prepare(
        `UPDATE cloud_history SET generation = ?, revision = revision + 1
         WHERE user_id = ? AND generation = ? AND revision = ?
           AND ${liveSessionSql}`
      ).bind(
        generation,
        user.id,
        active.generation,
        active.revision,
        c.get('sessionTokenHash'),
        user.id,
        Date.now()
      ),
      c.env.DB.prepare(
        `UPDATE cloud_imports SET status = 'committed', updated_at = ?
         WHERE user_id = ? AND id = ?
           AND changes() = 1
           AND EXISTS (
             SELECT 1 FROM cloud_history
             WHERE user_id = ? AND generation = ? AND revision = ?
           )`
      ).bind(Date.now(), user.id, importId, user.id, generation, active.revision + 1),
      c.env.DB.prepare(
        `UPDATE chats SET revision = ?
         WHERE user_id = ? AND generation = ?
           AND changes() = 1
           AND EXISTS (
             SELECT 1 FROM cloud_history
             WHERE user_id = ? AND generation = ? AND revision = ?
           )`
      ).bind(active.revision + 1, user.id, generation, user.id, generation, active.revision + 1),
    ])
    if (results[3].meta.changes === 0) {
      const live = await c.env.DB.prepare(`SELECT ${liveSessionSql} AS live`)
        .bind(c.get('sessionTokenHash'), user.id, Date.now())
        .first<{ live: number }>()
      await deleteR2Keys(c.env, keys)
      if (!live?.live) {
        throw new HTTPException(401, { message: '登录状态已变更，请重新登录' })
      }
      throw new HTTPException(409, { message: '账号历史已在其他设备更新，请重试导入' })
    }
    if (results[4].meta.changes === 0) {
      throw new Error('导入切换后任务状态未提交')
    }
  } catch (error) {
    await deleteR2Keys(c.env, keys)
    throw error
  }
  await deleteUnreferencedFilesBestEffort(c.env, user.id, false)
  await notifyHistoryChange(c.env, user.id)
  const listed = await listActiveChats(c.env, user.id)
  return jsonResponse({
    sessions: listed.sessions,
    generation: listed.generation,
    revision: listed.revision,
    count: listed.sessions.length,
  })
}

dataRoutes.post('/chats/import', legacyImportRoute)

dataRoutes.post('/files/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid file id')
  }

  const mimeType = (c.req.header('content-type') ?? 'application/octet-stream').trim()
  if (mimeType.length === 0 || mimeType.length > MAX_MIME_TYPE_LENGTH || /[\r\n]/.test(mimeType)) {
    return errorResponse('Invalid Content-Type')
  }

  const key = `${user.id}/files/${crypto.randomUUID()}`
  const object = await c.env.FILES.put(key, c.req.raw.body ?? new Uint8Array(), {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `attachment; filename="${id}"`,
    },
  })
  const written = await c.env.DB.prepare(
    `INSERT INTO files (user_id, id, r2_key, mime_type, size, created_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE ${liveSessionSql}
     ON CONFLICT(user_id, id) DO UPDATE SET
       r2_key = excluded.r2_key,
       mime_type = excluded.mime_type,
       size = excluded.size`
  )
    .bind(
      user.id,
      id,
      key,
      mimeType,
      object.size,
      Date.now(),
      c.get('sessionTokenHash'),
      user.id,
      Date.now()
    )
    .run()
  if (written.meta.changes === 0) {
    await c.env.FILES.delete(key)
    throw new HTTPException(401, { message: '登录状态已变更，请重新登录' })
  }
  await notifyHistoryChange(c.env, user.id)
  return noContent()
})

dataRoutes.get('/files/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid file id')
  }
  const row = await c.env.DB.prepare(
    'SELECT r2_key, mime_type, size FROM files WHERE user_id = ? AND id = ?'
  )
    .bind(user.id, id)
    .first<FileRow>()
  if (!row || !isScopedR2Key(row.r2_key, user.id)) {
    return errorResponse('File not found', 404)
  }

  const object = await c.env.FILES.get(row.r2_key)
  if (!object) {
    return errorResponse('File not found', 404)
  }
  return new Response(object.body, {
    headers: {
      'content-type': row.mime_type,
      'content-disposition': `attachment; filename="${id}"`,
      'content-length': String(object.size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  })
})

dataRoutes.delete('/files/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid file id')
  }
  const row = await c.env.DB.prepare('SELECT r2_key FROM files WHERE user_id = ? AND id = ?')
    .bind(user.id, id)
    .first<FileKeyRow>()
  if (row) {
    if (isScopedR2Key(row.r2_key, user.id)) {
      await c.env.FILES.delete(row.r2_key)
    }
  }
  await c.env.DB.prepare('DELETE FROM files WHERE user_id = ? AND id = ?').bind(user.id, id).run()
  await notifyHistoryChange(c.env, user.id)
  return noContent()
})

dataRoutes.get('/settings', async (c) => {
  const user = c.get('user')
  const row = await c.env.DB.prepare('SELECT api_key_ciphertext FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ api_key_ciphertext: string | null }>()
  if (!row) {
    return errorResponse('User not found', 404)
  }
  return jsonResponse({ hasCustomApiKey: row.api_key_ciphertext !== null })
})

dataRoutes.put('/settings/api-key', async (c) => {
  const user = c.get('user')
  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('Invalid JSON body')
  }
  if (!isRecord(body) || !('apiKey' in body)) {
    return errorResponse('apiKey is required')
  }
  if (body.apiKey !== null && typeof body.apiKey !== 'string') {
    return errorResponse('apiKey must be a string or null')
  }

  const apiKey = body.apiKey === null ? null : validateCustomApiKey(body.apiKey)
  if (apiKey !== null) {
    assertApiKeyEncryptionConfigured(c.env.API_KEY_ENCRYPTION_KEY)
    await rateLimit(c, `verify-key:${user.id}`, 20)
    const failure = await verifyCustomApiKey(c, apiKey)
    if (failure) {
      return failure
    }
  }
  const ciphertext =
    apiKey === null ? null : await encryptApiKey(apiKey, c.env.API_KEY_ENCRYPTION_KEY)
  // 校验涉及上游等待，提交时必须再次确认会话仍有效。
  const result = await c.env.DB.prepare(
    `UPDATE users SET api_key_ciphertext = ? WHERE id = ? AND ${liveSessionSql}`
  )
    .bind(ciphertext, user.id, c.get('sessionTokenHash'), user.id, Date.now())
    .run()
  if (result.meta.changes === 0) {
    throw new HTTPException(401, { message: '登录已失效，请重新登录' })
  }
  await notifyHistoryChange(c.env, user.id)
  return jsonResponse({ hasCustomApiKey: ciphertext !== null })
})

dataRoutes.delete('/settings/api-key', async (c) => {
  const user = c.get('user')
  const result = await c.env.DB.prepare(
    `UPDATE users SET api_key_ciphertext = NULL WHERE id = ? AND ${liveSessionSql}`
  )
    .bind(user.id, c.get('sessionTokenHash'), user.id, Date.now())
    .run()
  if (result.meta.changes === 0) {
    throw new HTTPException(401, { message: '登录已失效，请重新登录' })
  }
  await notifyHistoryChange(c.env, user.id)
  return noContent()
})

export const adminRoutes = new Hono<AppEnv>()

adminRoutes.post('/invites', async (c) => {
  const user = c.get('user')
  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('Invalid JSON body')
  }
  if (!isRecord(body)) {
    return errorResponse('Invalid invitation')
  }

  const maxUses = body.maxUses ?? body.max_uses
  const expiresAt = body.expiresAt ?? body.expires_at ?? null
  if (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    return errorResponse('maxUses must be an integer from 1 to 1000')
  }
  if (expiresAt !== null && (!isTimestamp(expiresAt) || expiresAt <= Date.now())) {
    return errorResponse('expiresAt must be a future millisecond timestamp')
  }

  const id = crypto.randomUUID()
  const code = randomToken()
  const codeHash = await sha256(code)
  const createdAt = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO invites
       (id, code_hash, max_uses, uses, expires_at, created_by, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(id, codeHash, maxUses, expiresAt, user.id, createdAt)
    .run()

  return jsonResponse(
    {
      invite: inviteView(
        {
          id,
          code_hash: codeHash,
          max_uses: maxUses,
          uses: 0,
          expires_at: expiresAt,
          created_by: user.id,
          created_at: createdAt,
        },
        code
      ),
    },
    201
  )
})

adminRoutes.get('/invites', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, code_hash, max_uses, uses, expires_at, created_by, created_at
     FROM invites
     ORDER BY created_at DESC, id ASC`
  ).all<InviteRow>()
  return jsonResponse({ invites: rows.results.map((row) => inviteView(row, null)) })
})

adminRoutes.delete('/invites/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid invitation id')
  }
  await c.env.DB.prepare('DELETE FROM invites WHERE id = ?').bind(id).run()
  return noContent()
})

adminRoutes.get('/users', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT
       u.id,
       u.username,
       u.role,
       u.status,
       u.created_at AS createdAt,
       u.api_key_ciphertext,
       (SELECT COUNT(*) FROM chats chat WHERE chat.user_id = u.id) AS session_count
     FROM users u
     ORDER BY u.created_at DESC, u.id ASC`
  ).all<AdminUserRow>()

  return jsonResponse({
    users: rows.results.map(adminUserView),
  })
})

adminRoutes.patch('/users/:id', async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid user id')
  }

  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('Invalid JSON body')
  }
  if (!isRecord(body)) {
    return errorResponse('Invalid user update')
  }
  const hasPassword = Object.prototype.hasOwnProperty.call(body, 'password')
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status')
  if (!hasPassword && !hasStatus) {
    return errorResponse('password or status is required')
  }
  if (
    hasPassword &&
    (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128)
  ) {
    return errorResponse('password must contain 10 to 128 characters')
  }
  if (hasStatus && body.status !== 'active' && body.status !== 'disabled') {
    return errorResponse('status must be active or disabled')
  }

  const target = await c.env.DB.prepare('SELECT id, role, status FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; role: 'admin' | 'user'; status: 'active' | 'disabled' }>()
  if (!target) {
    return errorResponse('User not found', 404)
  }
  if (id === actor.id && body.status === 'disabled') {
    return errorResponse('An administrator cannot disable their own account')
  }
  if (hasPassword && target.role === 'admin') {
    return errorResponse('Administrator passwords are managed by ADMIN_PASSWORD')
  }

  const passwordHash =
    hasPassword && typeof body.password === 'string'
      ? await hashPassword(body.password)
      : target.role === 'admin'
        ? null
        : undefined
  const statements = []
  if (hasPassword && hasStatus) {
    statements.push(
      c.env.DB.prepare('UPDATE users SET password_hash = ?, status = ? WHERE id = ?').bind(
        passwordHash ?? null,
        body.status,
        id
      )
    )
  } else if (hasPassword) {
    statements.push(
      c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(
        passwordHash ?? null,
        id
      )
    )
  } else {
    statements.push(
      c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(body.status, id)
    )
  }
  statements.push(c.env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(id))
  await c.env.DB.batch(statements)
  const updated = await c.env.DB.prepare(
    `SELECT
       u.id,
       u.username,
       u.role,
       u.status,
       u.created_at AS createdAt,
       u.api_key_ciphertext,
       (SELECT COUNT(*) FROM chats chat WHERE chat.user_id = u.id) AS session_count
     FROM users u
     WHERE u.id = ?`
  )
    .bind(id)
    .first<AdminUserRow>()
  if (!updated) {
    return errorResponse('User not found', 404)
  }
  return jsonResponse({ user: adminUserView(updated) })
})

adminRoutes.delete('/users/:id', async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid user id')
  }
  if (id === actor.id) {
    return errorResponse('An administrator cannot delete their own account')
  }

  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string }>()
  if (!target) {
    return errorResponse('User not found', 404)
  }
  await cleanupUserFiles(c.env, id)
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
  return noContent()
})

adminRoutes.delete('/users/:id/chats', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid user id')
  }
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string }>()
  if (!target) {
    return errorResponse('User not found', 404)
  }
  await clearUserChats(c.env, id, true)
  return noContent()
})
