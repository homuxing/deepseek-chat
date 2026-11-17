import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { encryptApiKey, hashPassword, randomToken, sha256 } from './security.js'
import type { AppEnv } from './types.js'

const MAX_SESSION_BYTES = 900 * 1024
const MAX_IMPORT_BYTES = 1024 * 1024
const MAX_IMPORT_SESSIONS = 200
const MAX_ID_LENGTH = 128
const MAX_TITLE_LENGTH = 500
const MAX_MIME_TYPE_LENGTH = 255
const R2_DELETE_BATCH_SIZE = 500
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const encoder = new TextEncoder()

// Recheck inside the write statement, since administrator cleanup may revoke a session during an upload.
const liveSessionSql = `EXISTS (
  SELECT 1 FROM auth_sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ? AND u.status = 'active'
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

type SessionSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>

type ChatSummaryRow = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

type ChatRow = {
  data_json: string
}

type FileRow = {
  r2_key: string
  mime_type: string
  size: number
}

type FileKeyRow = {
  r2_key: string
}

type FileIdRow = {
  id: string
}

type ScopedR2File = {
  id: string
  key: string
}

type AdminUserRow = {
  id: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  createdAt: number
  access_sub: string | null
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

const summarize = (session: Session): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

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
    value.title.length > MAX_TITLE_LENGTH ||
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
  accessSub: row.access_sub,
  sessionCount: Number(row.session_count),
  hasCustomApiKey: row.api_key_ciphertext !== null,
})

const scopedR2Keys = (keys: string[], userId: string): string[] => {
  const prefix = `${userId}/`
  return keys.filter((key) => {
    if (!key.startsWith(prefix)) {
      return false
    }
    const fileId = key.slice(prefix.length)
    return isValidId(fileId) && fileId !== '.' && fileId !== '..'
  })
}

const deleteR2Keys = async (env: AppEnv['Bindings'], keys: string[]): Promise<void> => {
  for (let offset = 0; offset < keys.length; offset += R2_DELETE_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + R2_DELETE_BATCH_SIZE)
    if (batch.length > 0) {
      await env.FILES.delete(batch)
    }
  }
}

const listUserR2Files = async (
  env: AppEnv['Bindings'],
  userId: string
): Promise<ScopedR2File[]> => {
  if (!isValidId(userId)) {
    throw new Error('Invalid user id')
  }
  const prefix = `${userId}/`
  const files: ScopedR2File[] = []
  let cursor: string | undefined
  do {
    const page = await env.FILES.list({ prefix, cursor, limit: 1000 })
    for (const object of page.objects) {
      const id = object.key.slice(prefix.length)
      if (object.key.startsWith(prefix) && isValidId(id)) {
        files.push({ id, key: object.key })
      }
    }
    if (page.truncated && !page.cursor) {
      throw new Error('R2 returned a truncated page without a cursor')
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return files
}

const deleteUnreferencedFiles = async (env: AppEnv['Bindings'], userId: string): Promise<void> => {
  const [referenced, metadata, objects] = await Promise.all([
    env.DB.prepare(
      `SELECT DISTINCT json_extract(referenced.value, '$.id') AS id
       FROM chats chat
       JOIN json_each(chat.data_json, '$.messages') message
       JOIN json_each(message.value, '$.files') referenced
       WHERE chat.user_id = ?
         AND json_type(referenced.value, '$.id') = 'text'`
    )
      .bind(userId)
      .all<FileIdRow>(),
    env.DB.prepare('SELECT id FROM files WHERE user_id = ?').bind(userId).all<FileIdRow>(),
    listUserR2Files(env, userId),
  ])
  const referencedIds = new Set(referenced.results.map((row) => row.id))
  const orphanObjects = objects.filter((object) => !referencedIds.has(object.id))
  const orphanMetadata = metadata.results.filter((row) => !referencedIds.has(row.id))

  await deleteR2Keys(
    env,
    orphanObjects.map((object) => object.key)
  )
  if (orphanMetadata.length > 0) {
    await env.DB.batch(
      orphanMetadata.map((row) =>
        env.DB.prepare('DELETE FROM files WHERE user_id = ? AND id = ?').bind(userId, row.id)
      )
    )
  }
}

const deleteUnreferencedFilesBestEffort = async (
  env: AppEnv['Bindings'],
  userId: string
): Promise<void> => {
  try {
    await deleteUnreferencedFiles(env, userId)
  } catch {
    // A later successful import or full clear will retry the orphan cleanup.
  }
}

const deleteUserFileObjects = async (env: AppEnv['Bindings'], userId: string): Promise<void> => {
  const objects = await listUserR2Files(env, userId)
  await deleteR2Keys(
    env,
    objects.map((object) => object.key)
  )
}

export const cleanupUserFiles = async (env: AppEnv['Bindings'], userId: string): Promise<void> => {
  await deleteUserFileObjects(env, userId)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM files WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM api_files WHERE user_id = ?').bind(userId),
  ])
}

const clearUserChats = async (
  env: AppEnv['Bindings'],
  userId: string,
  revokeSessions = false
): Promise<void> => {
  await deleteUserFileObjects(env, userId)
  const statements = [
    env.DB.prepare('DELETE FROM files WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM api_files WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM chats WHERE user_id = ?').bind(userId),
  ]
  if (revokeSessions) {
    statements.push(
      env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM login_handoffs WHERE user_id = ?').bind(userId)
    )
  }
  await env.DB.batch(statements)
}

export const dataRoutes = new Hono<AppEnv>()

dataRoutes.get('/chats', async (c) => {
  const user = c.get('user')
  const rows = await c.env.DB.prepare(
    `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
     FROM chats
     WHERE user_id = ?
     ORDER BY updated_at DESC, created_at DESC, id ASC`
  )
    .bind(user.id)
    .all<ChatSummaryRow>()

  const sessions: SessionSummary[] = rows.results.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
  return jsonResponse({ sessions })
})

dataRoutes.get('/chats/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid chat id')
  }
  const row = await c.env.DB.prepare('SELECT data_json FROM chats WHERE user_id = ? AND id = ?')
    .bind(user.id, id)
    .first<ChatRow>()
  if (!row) {
    return errorResponse('Chat not found', 404)
  }

  try {
    const value = JSON.parse(row.data_json) as unknown
    if (!isRecord(value) || value.id !== id) {
      return errorResponse('Stored chat is invalid', 500)
    }
    return jsonResponse({ session: value })
  } catch {
    return errorResponse('Stored chat is invalid', 500)
  }
})

dataRoutes.put('/chats/:id', async (c) => {
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
  if (!isRecord(body) || !('session' in body)) {
    return errorResponse('session is required')
  }
  const session = validateSession(body.session)
  if (!session || session.id !== id) {
    return errorResponse('Invalid session')
  }

  const dataJson = JSON.stringify(session)
  if (encoder.encode(dataJson).byteLength > MAX_SESSION_BYTES) {
    return errorResponse('Session is too large', 413)
  }

  const written = await c.env.DB.prepare(
    `INSERT INTO chats (user_id, id, title, created_at, updated_at, data_json)
     SELECT ?, ?, ?, ?, ?, ? WHERE ${liveSessionSql}
     ON CONFLICT(user_id, id) DO UPDATE SET
       title = excluded.title,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       data_json = excluded.data_json`
  )
    .bind(
      user.id,
      session.id,
      session.title,
      session.createdAt,
      session.updatedAt,
      dataJson,
      c.get('sessionTokenHash'),
      user.id,
      Date.now()
    )
    .run()
  if (written.meta.changes === 0) {
    throw new HTTPException(401, { message: '登录状态已变更，请重新登录' })
  }
  return noContent()
})

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
  if (!isRecord(body) || typeof body.title !== 'string' || body.title.length > MAX_TITLE_LENGTH) {
    return errorResponse('Invalid title')
  }

  const row = await c.env.DB.prepare('SELECT data_json FROM chats WHERE user_id = ? AND id = ?')
    .bind(user.id, id)
    .first<ChatRow>()
  if (!row) {
    return errorResponse('Chat not found', 404)
  }

  let session: JsonRecord
  try {
    const value = JSON.parse(row.data_json) as unknown
    if (!isRecord(value) || value.id !== id) {
      throw new Error('Invalid stored session')
    }
    session = { ...value, title: body.title }
  } catch {
    return errorResponse('Stored chat is invalid', 500)
  }

  const dataJson = JSON.stringify(session)
  if (encoder.encode(dataJson).byteLength > MAX_SESSION_BYTES) {
    return errorResponse('Session is too large', 413)
  }
  const result = await c.env.DB.prepare(
    'UPDATE chats SET title = ?, data_json = ? WHERE user_id = ? AND id = ?'
  )
    .bind(body.title, dataJson, user.id, id)
    .run()
  if (result.meta.changes === 0) {
    return errorResponse('Chat not found', 404)
  }
  return noContent()
})

dataRoutes.delete('/chats/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!isValidId(id)) {
    return errorResponse('Invalid chat id')
  }

  const [deleted, remaining, objects] = await Promise.all([
    c.env.DB.prepare(
      `SELECT DISTINCT json_extract(deleted_file.value, '$.id') AS id
       FROM chats chat
       JOIN json_each(chat.data_json, '$.messages') message
       JOIN json_each(message.value, '$.files') deleted_file
       WHERE chat.user_id = ?
         AND chat.id = ?
         AND json_type(deleted_file.value, '$.id') = 'text'`
    )
      .bind(user.id, id)
      .all<FileIdRow>(),
    c.env.DB.prepare(
      `SELECT DISTINCT json_extract(referenced.value, '$.id') AS id
       FROM chats remaining
       JOIN json_each(remaining.data_json, '$.messages') message
       JOIN json_each(message.value, '$.files') referenced
       WHERE remaining.user_id = ?
         AND remaining.id <> ?
         AND json_type(referenced.value, '$.id') = 'text'`
    )
      .bind(user.id, id)
      .all<FileIdRow>(),
    listUserR2Files(c.env, user.id),
  ])
  const remainingIds = new Set(remaining.results.map((row) => row.id))
  const orphanIds = deleted.results
    .map((row) => row.id)
    .filter((fileId) => !remainingIds.has(fileId))
  const orphanSet = new Set(orphanIds)

  await deleteR2Keys(
    c.env,
    objects.filter((object) => orphanSet.has(object.id)).map((object) => object.key)
  )
  await c.env.DB.batch([
    ...orphanIds.map((fileId) =>
      c.env.DB.prepare('DELETE FROM files WHERE user_id = ? AND id = ?').bind(user.id, fileId)
    ),
    c.env.DB.prepare('DELETE FROM chats WHERE user_id = ? AND id = ?').bind(user.id, id),
  ])
  return noContent()
})

dataRoutes.delete('/chats', async (c) => {
  const user = c.get('user')
  await clearUserChats(c.env, user.id)
  return noContent()
})

dataRoutes.post('/chats/import', async (c) => {
  const user = c.get('user')
  const contentLength = Number(c.req.header('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_BYTES) {
    return errorResponse('Import is too large', 413)
  }

  const bodyBytes = await c.req.arrayBuffer()
  if (bodyBytes.byteLength > MAX_IMPORT_BYTES) {
    return errorResponse('Import is too large', 413)
  }

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown
  } catch {
    return errorResponse('Invalid JSON body')
  }
  if (!isRecord(body) || !Array.isArray(body.sessions)) {
    return errorResponse('sessions must be an array')
  }
  if (body.sessions.length > MAX_IMPORT_SESSIONS) {
    return errorResponse(`At most ${MAX_IMPORT_SESSIONS} sessions can be imported`)
  }

  const sessions: ValidatedSession[] = []
  const ids = new Set<string>()
  for (const candidate of body.sessions) {
    const session = validateSession(candidate)
    if (!session) {
      return errorResponse('Invalid session')
    }
    const serialized = JSON.stringify(session)
    if (encoder.encode(serialized).byteLength > MAX_SESSION_BYTES) {
      return errorResponse('Session is too large', 413)
    }
    if (ids.has(session.id)) {
      return errorResponse('Duplicate session id')
    }
    ids.add(session.id)
    sessions.push(session)
  }

  const statements = [
    c.env.DB.prepare(`DELETE FROM chats WHERE user_id = ? AND ${liveSessionSql}`).bind(
      user.id,
      c.get('sessionTokenHash'),
      user.id,
      Date.now()
    ),
    ...sessions.map((session) =>
      c.env.DB.prepare(
        `INSERT INTO chats (user_id, id, title, created_at, updated_at, data_json)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${liveSessionSql}`
      ).bind(
        user.id,
        session.id,
        session.title,
        session.createdAt,
        session.updatedAt,
        JSON.stringify(session),
        c.get('sessionTokenHash'),
        user.id,
        Date.now()
      )
    ),
  ]
  const committed = await c.env.DB.batch(statements)
  if (sessions.length > 0 && committed[1].meta.changes !== 1) {
    throw new HTTPException(401, { message: '登录状态已变更，请重新登录' })
  }
  await deleteUnreferencedFilesBestEffort(c.env, user.id)
  return jsonResponse({ sessions: sessions.map(summarize) })
})

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

  const key = `${user.id}/${id}`
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
  if (!row || !scopedR2Keys([row.r2_key], user.id).length) {
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
    const [key] = scopedR2Keys([row.r2_key], user.id)
    if (key) {
      await c.env.FILES.delete(key)
    }
  }
  await c.env.DB.prepare('DELETE FROM files WHERE user_id = ? AND id = ?').bind(user.id, id).run()
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

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : null
  if (apiKey !== null && (apiKey.length === 0 || apiKey.length > 512 || /[\r\n]/.test(apiKey))) {
    return errorResponse('Invalid API key')
  }
  const ciphertext =
    apiKey === null ? null : await encryptApiKey(apiKey, c.env.API_KEY_ENCRYPTION_KEY)
  const result = await c.env.DB.prepare('UPDATE users SET api_key_ciphertext = ? WHERE id = ?')
    .bind(ciphertext, user.id)
    .run()
  if (result.meta.changes === 0) {
    return errorResponse('User not found', 404)
  }
  return jsonResponse({ hasCustomApiKey: ciphertext !== null })
})

dataRoutes.delete('/settings/api-key', async (c) => {
  const user = c.get('user')
  const result = await c.env.DB.prepare('UPDATE users SET api_key_ciphertext = NULL WHERE id = ?')
    .bind(user.id)
    .run()
  if (result.meta.changes === 0) {
    return errorResponse('User not found', 404)
  }
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
       u.access_sub,
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
    return errorResponse('Administrator passwords are managed by Access')
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
       u.access_sub,
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
