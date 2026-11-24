import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { publishHistoryChange } from './sync.js'
import type { AppEnv, UserRow } from './types.js'

const MAX_ID_LENGTH = 128
const MAX_MIME_TYPE_LENGTH = 255
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const R2_DELETE_BATCH_SIZE = 500

type JsonRecord = Record<string, unknown>

export type SessionSummary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  revision?: number
  generation?: string
}

export type ActiveHistory = {
  generation: string
  revision: number
}

type ChatRow = {
  id: string
  generation: string
  revision: number
  title: string
  pinned: number
  createdAt: number
  updatedAt: number
  data_json: string
  body_key: string | null
}

type FileRow = {
  id: string
  r2_key: string
  created_at: number
}

type UploadRow = {
  id: string
  kind: 'chat' | 'file'
  object_id: string
  generation: string | null
  import_id: string | null
  base_revision: number | null
  r2_key: string
  multipart_id: string
  summary_json: string | null
  files_json: string
  mime_type: string | null
  completed_revision: number | null
  status: 'uploading' | 'completing' | 'completed' | 'failed' | 'cancelled'
}

type ImportRow = {
  id: string
  generation: string
  base_revision: number
  status: 'staging' | 'committed' | 'cancelled'
  count: number
  revision: number
}

type UploadedPartRow = {
  part_number: number
  etag: string
}

type SessionRow = Pick<
  ChatRow,
  'id' | 'generation' | 'revision' | 'title' | 'pinned' | 'createdAt' | 'updatedAt'
>

const liveSessionSql = `EXISTS (
  SELECT 1 FROM auth_sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.user_id = ? AND MIN(s.expires_at, s.absolute_expires_at) > ?
    AND s.auth_version = u.auth_version AND u.status = 'active'
)`

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isValidId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH &&
  SAFE_IDENTIFIER.test(value)

const isGeneration = (value: unknown): value is string =>
  isValidId(value) && value !== '.' && value !== '..'

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isChatRevision = (value: unknown): value is number =>
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

export const resolveExpectedHistory = (
  body: JsonRecord,
  headers: Headers,
  active: ActiveHistory,
  fallbackRevision = 0
): { generation: string; revision: number } | null => {
  const rawGeneration = headers.get('X-Chat-Generation') ?? body.generation
  const rawRevision = headers.get('X-Chat-Revision') ?? body.expectedRevision
  const revision =
    typeof rawRevision === 'string' && rawRevision.trim() !== ''
      ? Number(rawRevision)
      : rawRevision === undefined
        ? fallbackRevision
        : rawRevision
  const generation = rawGeneration === undefined ? active.generation : rawGeneration
  if (!isGeneration(generation) || !isChatRevision(revision)) {
    return null
  }
  return { generation, revision }
}

const isScopedR2Key = (userId: string, key: string): boolean => {
  const prefix = `${userId}/`
  if (!key.startsWith(prefix) || key.length === prefix.length) {
    return false
  }
  const parts = key.slice(prefix.length).split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

const isR2KeyReferenced = async (
  env: AppEnv['Bindings'],
  userId: string,
  key: string
): Promise<boolean> => {
  const row = await env.DB.prepare(
    `SELECT 1 AS found
     WHERE EXISTS (SELECT 1 FROM chats WHERE user_id = ? AND body_key = ?)
        OR EXISTS (SELECT 1 FROM files WHERE user_id = ? AND r2_key = ?)
        OR EXISTS (
          SELECT 1 FROM cloud_uploads
          WHERE user_id = ? AND r2_key = ?
            AND status IN ('uploading', 'completing', 'completed')
        )`
  )
    .bind(userId, key, userId, key, userId, key)
    .first<{ found: number }>()
  return Boolean(row?.found)
}

const deleteR2Keys = async (env: AppEnv['Bindings'], keys: string[]): Promise<void> => {
  const unique = [...new Set(keys)]
  for (let offset = 0; offset < unique.length; offset += R2_DELETE_BATCH_SIZE) {
    const batch = unique.slice(offset, offset + R2_DELETE_BATCH_SIZE)
    if (batch.length > 0) {
      await env.FILES.delete(batch)
    }
  }
}

export const notifyHistoryChange = async (
  env: AppEnv['Bindings'],
  userId: string
): Promise<void> => {
  try {
    await publishHistoryChange(env, userId)
  } catch (error) {
    // D1/R2 已经提交，通知失败由重连拉取补足；不能让客户端误判提交失败。
    // eslint-disable-next-line no-console
    console.warn('聊天历史已提交，但同步通知未送达', error)
  }
}

export const ensureActiveHistory = async (
  env: AppEnv['Bindings'],
  userId: string
): Promise<ActiveHistory> => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO cloud_history (user_id, generation, revision)
     VALUES (?, 'legacy', 1)`
  )
    .bind(userId)
    .run()
  const row = await env.DB.prepare(
    'SELECT generation, revision FROM cloud_history WHERE user_id = ?'
  )
    .bind(userId)
    .first<ActiveHistory>()
  if (!row) {
    throw new Error('Cloud history pointer was not created')
  }
  return row
}

const sessionSummary = (row: SessionRow): SessionSummary => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  pinned: Boolean(row.pinned),
  revision: row.revision,
  generation: row.generation,
})

export const listActiveChats = async (
  env: AppEnv['Bindings'],
  userId: string
): Promise<{ sessions: SessionSummary[]; generation: string; revision: number }> => {
  await ensureActiveHistory(env, userId)
  const [historyResult, chatResult] = await env.DB.batch([
    env.DB.prepare('SELECT generation, revision FROM cloud_history WHERE user_id = ?').bind(userId),
    env.DB.prepare(
      `SELECT id, generation, revision, title, pinned,
              created_at AS createdAt, updated_at AS updatedAt
       FROM chats
       WHERE user_id = ?
         AND generation = (
           SELECT generation FROM cloud_history WHERE user_id = ?
         )
       ORDER BY updated_at DESC, created_at DESC, id ASC`
    ).bind(userId, userId),
  ])
  const active = historyResult.results[0] as ActiveHistory | undefined
  if (!active) {
    throw new Error('Cloud history pointer was not found')
  }
  return {
    sessions: (chatResult.results as SessionRow[]).map(sessionSummary),
    generation: active.generation,
    revision: active.revision,
  }
}

export type LoadedChat =
  | { kind: 'ok'; session: JsonRecord; summary: SessionSummary }
  | { kind: 'not_found' }
  | { kind: 'invalid'; message: string }

export const loadActiveChat = async (
  env: AppEnv['Bindings'],
  userId: string,
  id: string
): Promise<LoadedChat> => {
  await ensureActiveHistory(env, userId)
  // 在同一条查询中读取当前代次，避免导入切换后仍按旧指针读取详情。
  const readCurrentRow = () =>
    env.DB.prepare(
      `SELECT id, generation, revision, title, pinned,
              created_at AS createdAt, updated_at AS updatedAt,
              data_json, body_key
       FROM chats
       WHERE user_id = ? AND id = ?
         AND generation = (
           SELECT generation FROM cloud_history WHERE user_id = ?
         )`
    )
      .bind(userId, id, userId)
      .first<ChatRow>()
  let row = await readCurrentRow()
  if (!row) {
    return { kind: 'not_found' }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let text = row.data_json
    if (row.body_key !== null) {
      if (!isScopedR2Key(userId, row.body_key)) {
        return { kind: 'invalid', message: '会话正文存储位置无效' }
      }
      const object = await env.FILES.get(row.body_key)
      if (!object) {
        const latest = await readCurrentRow()
        if (!latest) {
          return { kind: 'not_found' }
        }
        if (latest.body_key !== row.body_key || latest.revision !== row.revision) {
          row = latest
          continue
        }
        return { kind: 'invalid', message: '会话正文文件缺失' }
      }
      text = await object.text()
    }

    try {
      const value = JSON.parse(text) as unknown
      if (!isRecord(value) || value.id !== id) {
        return { kind: 'invalid', message: '会话正文内容无效' }
      }
      const session = { ...value, title: row.title, pinned: Boolean(row.pinned) }
      return { kind: 'ok', session, summary: sessionSummary(row) }
    } catch {
      return { kind: 'invalid', message: '会话正文内容无效' }
    }
  }
  return { kind: 'invalid', message: '会话正文文件缺失' }
}

const fileIdsFromSession = (session: JsonRecord): string[] => {
  const ids = new Set<string>()
  if (!Array.isArray(session.messages)) {
    return []
  }
  for (const message of session.messages) {
    if (!isRecord(message) || !Array.isArray(message.files)) {
      continue
    }
    for (const file of message.files) {
      if (isRecord(file) && isValidId(file.id)) {
        ids.add(file.id)
      }
    }
  }
  return [...ids]
}

const stageChatReferences = async (
  env: AppEnv['Bindings'],
  userId: string,
  bodyKey: string,
  fileIds: string[]
): Promise<void> => {
  const values = [...new Set(fileIds)]
  const chunkSize = 500
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    const chunk = values.slice(offset, offset + chunkSize)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO cloud_chat_refs (user_id, body_key, file_id, created_at)
       SELECT ?, ?, value, ? FROM json_each(?) WHERE type = 'text'`
    )
      .bind(userId, bodyKey, Date.now(), JSON.stringify(chunk))
      .run()
  }
}

const deleteStagedChatReferences = async (
  env: AppEnv['Bindings'],
  userId: string,
  bodyKey: string
): Promise<void> => {
  await env.DB.prepare('DELETE FROM cloud_chat_refs WHERE user_id = ? AND body_key = ?')
    .bind(userId, bodyKey)
    .run()
}

const cleanupImportFiles = async (
  env: AppEnv['Bindings'],
  userId: string,
  importId: string
): Promise<void> => {
  const candidates = await env.DB.prepare(
    `SELECT DISTINCT object_id AS id FROM cloud_uploads
     WHERE user_id = ? AND import_id = ? AND kind = 'file'`
  )
    .bind(userId, importId)
    .all<{ id: string }>()
  if (candidates.results.length === 0) {
    return
  }
  const candidateIds = candidates.results.map((row) => row.id)
  for (let offset = 0; offset < candidateIds.length; offset += 500) {
    const chunk = candidateIds.slice(offset, offset + 500)
    const files = await env.DB.prepare(
      `SELECT id, r2_key FROM files
       WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`
    )
      .bind(userId, JSON.stringify(chunk))
      .all<FileRow>()
    for (const file of files.results) {
      const key = await claimFileDeletion(env, userId, file, false)
      if (key) {
        await deleteR2Keys(env, [key])
      }
    }
  }
}

const claimFileDeletion = async (
  env: AppEnv['Bindings'],
  userId: string,
  file: Pick<FileRow, 'id' | 'r2_key'>,
  protectRecent: boolean
): Promise<string | null> => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const result = await env.DB.prepare(
    `DELETE FROM files
     WHERE user_id = ? AND id = ? AND r2_key = ?
       AND (? = 0 OR created_at < ?)
       AND NOT EXISTS (
         SELECT 1 FROM chat_files referenced
         WHERE referenced.user_id = files.user_id AND referenced.file_id = files.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM cloud_uploads pending
         WHERE pending.user_id = files.user_id
           AND pending.object_id = files.id
           AND pending.status IN ('uploading', 'completing')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM cloud_uploads pending
         JOIN cloud_imports imported
           ON imported.user_id = pending.user_id AND imported.id = pending.import_id
         WHERE pending.user_id = files.user_id
           AND pending.object_id = files.id
           AND pending.status = 'completed'
           AND imported.status = 'staging'
       )`
  )
    .bind(userId, file.id, file.r2_key, protectRecent ? 1 : 0, cutoff)
    .run()
  return result.meta.changes === 1 && isScopedR2Key(userId, file.r2_key) ? file.r2_key : null
}

export type SaveChatResult =
  | { kind: 'ok'; summary: SessionSummary }
  | { kind: 'conflict'; message: string }
  | { kind: 'unauthorized'; message: string }

export const saveChatSession = async (
  env: AppEnv['Bindings'],
  user: UserRow,
  sessionTokenHash: string,
  session: JsonRecord,
  expected: ActiveHistory
): Promise<SaveChatResult> => {
  const id = session.id as string
  const title = session.title as string
  const createdAt = session.createdAt as number
  const updatedAt = session.updatedAt as number
  const pinned = session.pinned === true ? 1 : 0
  const bodyKey = `${user.id}/chats/${expected.generation}/${id}/${crypto.randomUUID()}`
  const body = JSON.stringify(session)
  const previous = await env.DB.prepare(
    `SELECT body_key FROM chats
     WHERE user_id = ? AND generation = ? AND id = ?`
  )
    .bind(user.id, expected.generation, id)
    .first<{ body_key: string | null }>()

  await env.FILES.put(bodyKey, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })

  const nextRevision = expected.revision + 1
  const chatStatement =
    expected.revision === 0
      ? env.DB.prepare(
          `INSERT INTO chats
             (user_id, generation, id, revision, title, pinned,
              created_at, updated_at, data_json, body_key)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?
           WHERE changes() = 1 AND ${liveSessionSql}
             AND EXISTS (
             SELECT 1 FROM cloud_history
             WHERE user_id = ? AND generation = ?
           )
           ON CONFLICT(user_id, generation, id) DO NOTHING`
        ).bind(
          user.id,
          expected.generation,
          id,
          nextRevision,
          title,
          pinned,
          createdAt,
          updatedAt,
          bodyKey,
          sessionTokenHash,
          user.id,
          Date.now(),
          user.id,
          expected.generation
        )
      : env.DB.prepare(
          `UPDATE chats
           SET revision = ?, title = ?, pinned = ?, created_at = ?, updated_at = ?,
               data_json = '{}', body_key = ?
           WHERE user_id = ? AND generation = ? AND id = ? AND revision = ?
             AND changes() = 1 AND ${liveSessionSql}
             AND EXISTS (
               SELECT 1 FROM cloud_history
               WHERE user_id = ? AND generation = ?
             )`
        ).bind(
          nextRevision,
          title,
          pinned,
          createdAt,
          updatedAt,
          bodyKey,
          user.id,
          expected.generation,
          id,
          expected.revision,
          sessionTokenHash,
          user.id,
          Date.now(),
          user.id,
          expected.generation
        )
  try {
    const fileIds = fileIdsFromSession(session)
    await stageChatReferences(env, user.id, bodyKey, fileIds)
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE cloud_history
         SET revision = revision + 1
         WHERE user_id = ? AND generation = ? AND ${liveSessionSql}
           AND (
             (? = 0 AND NOT EXISTS (
               SELECT 1 FROM chats
               WHERE user_id = ? AND generation = ? AND id = ?
             ))
             OR EXISTS (
               SELECT 1 FROM chats
               WHERE user_id = ? AND generation = ? AND id = ? AND revision = ?
             )
           )`
      ).bind(
        user.id,
        expected.generation,
        sessionTokenHash,
        user.id,
        Date.now(),
        expected.revision,
        user.id,
        expected.generation,
        id,
        user.id,
        expected.generation,
        id,
        expected.revision
      ),
      chatStatement,
      env.DB.prepare(
        `DELETE FROM chat_files
         WHERE user_id = ? AND generation = ? AND chat_id = ?
           AND EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
           )`
      ).bind(user.id, expected.generation, id, user.id, expected.generation, id, bodyKey),
      env.DB.prepare(
        `INSERT OR IGNORE INTO chat_files (user_id, generation, chat_id, file_id)
         SELECT ?, ?, ?, file_id FROM cloud_chat_refs
         WHERE user_id = ? AND body_key = ?
           AND EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
           )`
      ).bind(
        user.id,
        expected.generation,
        id,
        user.id,
        bodyKey,
        user.id,
        expected.generation,
        id,
        bodyKey
      ),
      env.DB.prepare(
        `DELETE FROM cloud_chat_refs
         WHERE user_id = ? AND body_key = ?
           AND EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
           )`
      ).bind(user.id, bodyKey, user.id, expected.generation, id, bodyKey),
    ])
    if (results[0].meta.changes === 0 || results[1].meta.changes === 0) {
      const live = await env.DB.prepare(`SELECT ${liveSessionSql} AS live`)
        .bind(sessionTokenHash, user.id, Date.now())
        .first<{ live: number }>()
      await env.FILES.delete(bodyKey)
      await deleteStagedChatReferences(env, user.id, bodyKey)
      if (!live?.live) {
        return { kind: 'unauthorized', message: '登录状态已变更，请重新登录' }
      }
      return { kind: 'conflict', message: '会话已在其他设备更新，请刷新后重试' }
    }
    const oldKey = previous?.body_key
    if (oldKey && oldKey !== bodyKey && isScopedR2Key(user.id, oldKey)) {
      try {
        await env.FILES.delete(oldKey)
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('旧会话正文清理失败，将在后台清理中重试', error)
      }
    }
    return {
      kind: 'ok',
      summary: {
        id,
        title,
        createdAt,
        updatedAt,
        pinned: pinned === 1,
        revision: nextRevision,
        generation: expected.generation,
      },
    }
  } catch (error) {
    await env.FILES.delete(bodyKey)
    await deleteStagedChatReferences(env, user.id, bodyKey)
    throw error
  }
}

export type RenameChatResult =
  | { kind: 'ok'; summary: SessionSummary }
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string }
  | { kind: 'unauthorized'; message: string }

export const renameActiveChat = async (
  env: AppEnv['Bindings'],
  user: UserRow,
  sessionTokenHash: string,
  id: string,
  title: string,
  expected: ActiveHistory
): Promise<RenameChatResult> => {
  const current = await env.DB.prepare(
    `SELECT pinned, created_at AS createdAt, updated_at AS updatedAt
     FROM chats WHERE user_id = ? AND generation = ? AND id = ?`
  )
    .bind(user.id, expected.generation, id)
    .first<Pick<ChatRow, 'pinned' | 'createdAt' | 'updatedAt'>>()
  if (!current) {
    return { kind: 'not_found' }
  }
  const nextRevision = expected.revision + 1
  const updatedAt = Math.max(current.updatedAt, Date.now())
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE cloud_history SET revision = revision + 1
       WHERE user_id = ? AND generation = ? AND ${liveSessionSql}
         AND EXISTS (
           SELECT 1 FROM chats
           WHERE user_id = ? AND generation = ? AND id = ? AND revision = ?
         )`
    ).bind(
      user.id,
      expected.generation,
      sessionTokenHash,
      user.id,
      Date.now(),
      user.id,
      expected.generation,
      id,
      expected.revision
    ),
    env.DB.prepare(
      `UPDATE chats SET title = ?, updated_at = ?, revision = ?
       WHERE user_id = ? AND generation = ? AND id = ? AND revision = ?
         AND changes() = 1 AND ${liveSessionSql}
         AND EXISTS (
           SELECT 1 FROM cloud_history
           WHERE user_id = ? AND generation = ?
         )`
    ).bind(
      title,
      updatedAt,
      nextRevision,
      user.id,
      expected.generation,
      id,
      expected.revision,
      sessionTokenHash,
      user.id,
      Date.now(),
      user.id,
      expected.generation
    ),
  ])
  if (results[0].meta.changes === 0) {
    const live = await env.DB.prepare(`SELECT ${liveSessionSql} AS live`)
      .bind(sessionTokenHash, user.id, Date.now())
      .first<{ live: number }>()
    return live?.live
      ? { kind: 'conflict', message: '会话已在其他设备更新，请刷新后重试' }
      : { kind: 'unauthorized', message: '登录状态已变更，请重新登录' }
  }
  if (results[1].meta.changes === 0) {
    return { kind: 'conflict', message: '会话已在其他设备更新，请刷新后重试' }
  }
  return {
    kind: 'ok',
    summary: {
      id,
      title,
      createdAt: current.createdAt,
      updatedAt,
      pinned: Boolean(current.pinned),
      revision: nextRevision,
      generation: expected.generation,
    },
  }
}

export type DeleteChatResult =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'conflict'; message: string }
  | { kind: 'unauthorized'; message: string }

export const deleteActiveChat = async (
  env: AppEnv['Bindings'],
  user: UserRow,
  sessionTokenHash: string,
  id: string,
  expected: ActiveHistory
): Promise<DeleteChatResult> => {
  const current = await env.DB.prepare(
    `SELECT body_key FROM chats WHERE user_id = ? AND generation = ? AND id = ?`
  )
    .bind(user.id, expected.generation, id)
    .first<{ body_key: string | null }>()
  if (!current) {
    return { kind: 'not_found' }
  }
  const references = await env.DB.prepare(
    `SELECT file_id AS id FROM chat_files
     WHERE user_id = ? AND generation = ? AND chat_id = ?`
  )
    .bind(user.id, expected.generation, id)
    .all<{ id: string }>()

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE cloud_history SET revision = revision + 1
       WHERE user_id = ? AND generation = ? AND ${liveSessionSql}
         AND EXISTS (
           SELECT 1 FROM chats
           WHERE user_id = ? AND generation = ? AND id = ? AND revision = ?
         )`
    ).bind(
      user.id,
      expected.generation,
      sessionTokenHash,
      user.id,
      Date.now(),
      user.id,
      expected.generation,
      id,
      expected.revision
    ),
    env.DB.prepare(
      `DELETE FROM chats
       WHERE user_id = ? AND generation = ? AND id = ?
         AND changes() = 1 AND ${liveSessionSql}
         AND EXISTS (
           SELECT 1 FROM cloud_history
           WHERE user_id = ? AND generation = ?
         )`
    ).bind(
      user.id,
      expected.generation,
      id,
      sessionTokenHash,
      user.id,
      Date.now(),
      user.id,
      expected.generation
    ),
  ])
  if (results[0].meta.changes === 0) {
    const live = await env.DB.prepare(`SELECT ${liveSessionSql} AS live`)
      .bind(sessionTokenHash, user.id, Date.now())
      .first<{ live: number }>()
    return live?.live
      ? { kind: 'conflict', message: '会话已在其他设备更新，请刷新后重试' }
      : { kind: 'unauthorized', message: '登录状态已变更，请重新登录' }
  }
  if (results[1].meta.changes === 0) {
    return { kind: 'conflict', message: '会话已在其他设备更新，请刷新后重试' }
  }
  const candidateIds = references.results.map((row) => row.id)
  for (let offset = 0; offset < candidateIds.length; offset += 500) {
    const chunk = candidateIds.slice(offset, offset + 500)
    const files = await env.DB.prepare(
      `SELECT id, r2_key FROM files
       WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`
    )
      .bind(user.id, JSON.stringify(chunk))
      .all<FileRow>()
    for (const file of files.results) {
      const claimed = await claimFileDeletion(env, user.id, file, false)
      if (claimed) {
        await deleteR2Keys(env, [claimed])
      }
    }
  }
  if (current.body_key && isScopedR2Key(user.id, current.body_key)) {
    await env.FILES.delete(current.body_key)
  }
  return { kind: 'ok' }
}

export const deleteUnreferencedFiles = async (
  env: AppEnv['Bindings'],
  userId: string,
  protectRecent = true
): Promise<void> => {
  const metadata = await env.DB.prepare(
    'SELECT id, r2_key, created_at FROM files WHERE user_id = ?'
  )
    .bind(userId)
    .all<FileRow>()
  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const file of metadata.results) {
    if (protectRecent && file.created_at >= recentCutoff) {
      continue
    }
    const claimed = await claimFileDeletion(env, userId, file, protectRecent)
    if (claimed) {
      await deleteR2Keys(env, [claimed])
    }
  }
}

export const deleteUnreferencedFilesBestEffort = async (
  env: AppEnv['Bindings'],
  userId: string,
  protectRecent = true
): Promise<void> => {
  try {
    await deleteUnreferencedFiles(env, userId, protectRecent)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('未引用文件清理失败，将在下次清理时重试', error)
  }
}

export const cleanupExpiredGenerations = async (
  env: AppEnv['Bindings'],
  userId: string
): Promise<void> => {
  for (;;) {
    const deleted = await env.DB.prepare(
      `DELETE FROM chats
       WHERE rowid IN (
         SELECT chat.rowid
         FROM chats chat
         WHERE chat.user_id = ?
           AND chat.generation <> (
             SELECT generation FROM cloud_history WHERE user_id = chat.user_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM cloud_imports imported
             WHERE imported.user_id = chat.user_id
               AND imported.generation = chat.generation
               AND imported.status = 'staging'
           )
         LIMIT 500
       )
       RETURNING body_key`
    )
      .bind(userId)
      .all<{ body_key: string | null }>()
    if (deleted.results.length === 0) {
      break
    }
    await deleteR2Keys(
      env,
      deleted.results
        .map((row) => row.body_key)
        .filter((key): key is string => key !== null && isScopedR2Key(userId, key))
    )
  }
  await deleteUnreferencedFilesBestEffort(env, userId)
}

export const clearCloudChats = async (
  env: AppEnv['Bindings'],
  userId: string,
  revokeSessions = false,
  sessionTokenHash?: string
): Promise<void> => {
  const active = await ensureActiveHistory(env, userId)
  const [keyRows, uploads] = await Promise.all([
    env.DB.prepare(
      `SELECT body_key AS key FROM chats
       WHERE user_id = ? AND body_key IS NOT NULL
       UNION
       SELECT r2_key AS key FROM files WHERE user_id = ?
       UNION
       SELECT r2_key AS key FROM cloud_uploads WHERE user_id = ?`
    )
      .bind(userId, userId, userId)
      .all<{ key: string }>(),
    env.DB.prepare(
      `SELECT id, r2_key, multipart_id, status FROM cloud_uploads
       WHERE user_id = ? AND status IN ('uploading', 'completing', 'failed')`
    )
      .bind(userId)
      .all<Pick<UploadRow, 'id' | 'r2_key' | 'multipart_id' | 'status'>>(),
  ])
  const emptyGeneration = `empty_${crypto.randomUUID().replaceAll('-', '')}`
  const liveGuard = sessionTokenHash === undefined ? '' : `AND ${liveSessionSql}`
  const firstBindings =
    sessionTokenHash === undefined
      ? [emptyGeneration, userId, active.generation]
      : [emptyGeneration, userId, active.generation, sessionTokenHash, userId, Date.now()]
  const statements = [
    env.DB.prepare(
      `UPDATE cloud_history
       SET generation = ?, revision = revision + 1
       WHERE user_id = ? AND generation = ? ${liveGuard}`
    ).bind(...firstBindings),
    env.DB.prepare(
      `UPDATE cloud_imports SET status = 'cancelled', updated_at = ?
       WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM cloud_history
         WHERE user_id = ? AND generation = ?
       )`
    ).bind(Date.now(), userId, userId, emptyGeneration),
    env.DB.prepare(
      `UPDATE cloud_uploads SET status = 'cancelled', updated_at = ?
       WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM cloud_history
         WHERE user_id = ? AND generation = ?
       )`
    ).bind(Date.now(), userId, userId, emptyGeneration),
    env.DB.prepare(
      `DELETE FROM files
       WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM cloud_history
         WHERE user_id = ? AND generation = ?
       )`
    ).bind(userId, userId, emptyGeneration),
    env.DB.prepare(
      `DELETE FROM api_files
       WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM cloud_history
         WHERE user_id = ? AND generation = ?
       )`
    ).bind(userId, userId, emptyGeneration),
    env.DB.prepare(
      `DELETE FROM chats
       WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM cloud_history
         WHERE user_id = ? AND generation = ?
       )`
    ).bind(userId, userId, emptyGeneration),
    env.DB.prepare(
      `DELETE FROM cloud_imports
       WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM cloud_history
         WHERE user_id = ? AND generation = ?
       )`
    ).bind(userId, userId, emptyGeneration),
    env.DB.prepare(
      `DELETE FROM cloud_uploads
       WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM cloud_history
         WHERE user_id = ? AND generation = ?
       )`
    ).bind(userId, userId, emptyGeneration),
  ]
  if (revokeSessions) {
    statements.push(
      env.DB.prepare(
        `UPDATE users SET auth_version = auth_version + 1
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM cloud_history
           WHERE user_id = ? AND generation = ?
         )`
      ).bind(userId, userId, emptyGeneration)
    )
    statements.push(
      env.DB.prepare(
        `DELETE FROM auth_sessions
         WHERE user_id = ? AND EXISTS (
           SELECT 1 FROM cloud_history
           WHERE user_id = ? AND generation = ?
         )`
      ).bind(userId, userId, emptyGeneration)
    )
  }
  const results = await env.DB.batch(statements)
  if (results[0].meta.changes === 0) {
    throw new HTTPException(401, { message: '登录状态已变更，请重新登录' })
  }
  for (const upload of uploads.results) {
    try {
      await env.FILES.resumeMultipartUpload(upload.r2_key, upload.multipart_id).abort()
    } catch {
      // 完成中的 multipart 可能在切换后留下对象，下面只删除切换前已捕获的 key。
    }
  }
  await deleteR2Keys(
    env,
    keyRows.results.map((row) => row.key).filter((key) => isScopedR2Key(userId, key))
  )
}

/** 先取消任务再清理对象；分片和完成请求会依据状态拒绝继续发布。 */
const cleanupCancelledUpload = async (
  env: AppEnv['Bindings'],
  userId: string,
  upload: Pick<UploadRow, 'id' | 'r2_key' | 'multipart_id'>
): Promise<void> => {
  try {
    await env.FILES.resumeMultipartUpload(upload.r2_key, upload.multipart_id).abort()
  } catch (error) {
    // 已完成或已取消的 multipart 不再存在，仍需检查是否留下未引用对象。
    const missing =
      error instanceof Error &&
      /NoSuchUpload|multipart upload not found|multipart upload does not exist/i.test(error.message)
    if (!missing || (await isR2KeyReferenced(env, userId, upload.r2_key))) {
      throw error
    }
  }
  if (
    isScopedR2Key(userId, upload.r2_key) &&
    !(await isR2KeyReferenced(env, userId, upload.r2_key))
  ) {
    await env.FILES.delete(upload.r2_key)
  }
  await deleteStagedChatReferences(env, userId, upload.r2_key)
  await env.DB.prepare('DELETE FROM cloud_upload_parts WHERE user_id = ? AND upload_id = ?')
    .bind(userId, upload.id)
    .run()
}

const cancelImportUploads = async (
  env: AppEnv['Bindings'],
  userId: string,
  importId: string
): Promise<void> => {
  await env.DB.prepare(
    `UPDATE cloud_uploads SET status = 'cancelled', updated_at = ?
     WHERE user_id = ? AND import_id = ? AND status IN ('uploading', 'completing', 'failed')
       AND EXISTS (
         SELECT 1 FROM cloud_imports WHERE user_id = ? AND id = ? AND status = 'cancelled'
       )`
  )
    .bind(Date.now(), userId, importId, userId, importId)
    .run()
  const uploads = await env.DB.prepare(
    `SELECT id, r2_key, multipart_id FROM cloud_uploads
     WHERE user_id = ? AND import_id = ? AND status = 'cancelled'`
  )
    .bind(userId, importId)
    .all<Pick<UploadRow, 'id' | 'r2_key' | 'multipart_id'>>()
  for (const upload of uploads.results) {
    await cleanupCancelledUpload(env, userId, upload)
  }
}

export const cleanupAbandonedStorage = async (env: AppEnv['Bindings']): Promise<void> => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000

  for (;;) {
    const uploads = await env.DB.prepare(
      `SELECT user_id, id, r2_key, multipart_id
       FROM cloud_uploads
       WHERE status IN ('uploading', 'completing', 'failed', 'cancelled') AND updated_at < ?
       ORDER BY updated_at ASC
       LIMIT 100`
    )
      .bind(cutoff)
      .all<{
        user_id: string
        id: string
        r2_key: string
        multipart_id: string
      }>()
    if (uploads.results.length === 0) {
      break
    }
    for (const upload of uploads.results) {
      const claimed = await env.DB.prepare(
        `UPDATE cloud_uploads SET status = 'cancelled', updated_at = ?
         WHERE user_id = ? AND id = ?
           AND status IN ('uploading', 'completing', 'failed', 'cancelled') AND updated_at < ?`
      )
        .bind(Date.now(), upload.user_id, upload.id, cutoff)
        .run()
      if (claimed.meta.changes === 0) {
        continue
      }
      await cleanupCancelledUpload(env, upload.user_id, upload)
    }
  }

  for (;;) {
    const imports = await env.DB.prepare(
      `SELECT user_id, id, generation
       FROM cloud_imports
       WHERE status IN ('staging', 'cancelled') AND updated_at < ?
       ORDER BY updated_at ASC
       LIMIT 100`
    )
      .bind(cutoff)
      .all<{ user_id: string; id: string; generation: string }>()
    if (imports.results.length === 0) {
      break
    }
    for (const imported of imports.results) {
      const claimed = await env.DB.prepare(
        `UPDATE cloud_imports SET status = 'cancelled', updated_at = ?
          WHERE user_id = ? AND id = ? AND status IN ('staging', 'cancelled') AND updated_at < ?`
      )
        .bind(Date.now(), imported.user_id, imported.id, cutoff)
        .run()
      if (claimed.meta.changes === 0) {
        continue
      }
      await cancelImportUploads(env, imported.user_id, imported.id)
      await cleanupExpiredGenerations(env, imported.user_id)
      await cleanupImportFiles(env, imported.user_id, imported.id)
    }
  }

  for (;;) {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT chat.user_id
       FROM chats chat
       JOIN cloud_history history ON history.user_id = chat.user_id
       WHERE chat.generation <> history.generation
         AND NOT EXISTS (
           SELECT 1 FROM cloud_imports imported
           WHERE imported.user_id = chat.user_id
             AND imported.generation = chat.generation
             AND imported.status = 'staging'
         )
       ORDER BY chat.user_id
       LIMIT 100`
    ).all<{ user_id: string }>()
    const users = rows.results.map((row) => row.user_id)
    if (users.length === 0) {
      break
    }
    for (const userId of users) {
      await cleanupExpiredGenerations(env, userId)
    }
  }
}

const getImport = async (
  env: AppEnv['Bindings'],
  userId: string,
  id: string
): Promise<ImportRow | null> =>
  env.DB.prepare(
    `SELECT imported.id, imported.generation, imported.base_revision,
            imported.status, imported.count,
            CASE
              WHEN imported.status = 'committed' THEN history.revision
              ELSE imported.base_revision
            END AS revision
     FROM cloud_imports imported
     LEFT JOIN cloud_history history ON history.user_id = imported.user_id
     WHERE imported.user_id = ? AND imported.id = ?`
  )
    .bind(userId, id)
    .first<ImportRow>()

export const cloudStorageRoutes = new Hono<AppEnv>()

cloudStorageRoutes.get('/chats/imports/:id', async (c) => {
  const imported = await getImport(c.env, c.get('user').id, c.req.param('id'))
  if (!imported) {
    return errorResponse('导入任务不存在', 404)
  }
  return jsonResponse({
    status: imported.status,
    count: imported.count,
    generation: imported.generation,
    revision: imported.revision,
  })
})

cloudStorageRoutes.post('/chats/imports', async (c) => {
  const user = c.get('user')
  const active = await ensureActiveHistory(c.env, user.id)
  const id = crypto.randomUUID()
  const generation = `import_${crypto.randomUUID().replaceAll('-', '')}`
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO cloud_imports
       (user_id, id, generation, base_revision, status, count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'staging', 0, ?, ?)`
  )
    .bind(user.id, id, generation, active.revision, now, now)
    .run()
  return jsonResponse({ id, generation, revision: active.revision }, 201)
})

cloudStorageRoutes.delete('/chats/imports/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const imported = await getImport(c.env, user.id, id)
  if (!imported) {
    return errorResponse('导入任务不存在', 404)
  }
  if (imported.status === 'committed') {
    return errorResponse('该导入任务已结束，无法取消', 409)
  }
  const result = await c.env.DB.prepare(
    `UPDATE cloud_imports SET status = 'cancelled', updated_at = ?
     WHERE user_id = ? AND id = ? AND status = 'staging'`
  )
    .bind(Date.now(), user.id, id)
    .run()
  if (result.meta.changes === 0) {
    const current = await getImport(c.env, user.id, id)
    if (current?.status !== 'cancelled') {
      return errorResponse('导入任务状态已变化', 409)
    }
  }
  await cancelImportUploads(c.env, user.id, id)
  await cleanupExpiredGenerations(c.env, user.id)
  await cleanupImportFiles(c.env, user.id, id)
  return noContent()
})

cloudStorageRoutes.post('/chats/imports/:id/commit', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('请求内容不是有效 JSON')
  }
  if (
    !isRecord(body) ||
    typeof body.count !== 'number' ||
    !Number.isSafeInteger(body.count) ||
    body.count < 0
  ) {
    return errorResponse('count 必须是非负整数')
  }
  const imported = await getImport(c.env, user.id, id)
  if (!imported) {
    return errorResponse('导入任务不存在', 404)
  }
  if (imported.status === 'cancelled') {
    return errorResponse('导入任务已取消', 409)
  }
  if (imported.status === 'committed') {
    const active = await ensureActiveHistory(c.env, user.id)
    if (active.generation !== imported.generation || imported.count !== body.count) {
      return errorResponse('导入任务已提交，但当前账号历史已变化', 409)
    }
    const listed = await listActiveChats(c.env, user.id)
    return jsonResponse({
      sessions: listed.sessions,
      generation: listed.generation,
      revision: listed.revision,
      count: imported.count,
    })
  }

  const actual = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM chats WHERE user_id = ? AND generation = ?`
  )
    .bind(user.id, imported.generation)
    .first<{ count: number }>()
  if (!actual || Number(actual.count) !== body.count) {
    return errorResponse('导入会话数量与已上传数量不一致', 409)
  }
  const unfinished = await c.env.DB.prepare(
    `SELECT 1 AS found FROM cloud_uploads
     WHERE user_id = ? AND import_id = ? AND status <> 'completed' LIMIT 1`
  )
    .bind(user.id, id)
    .first<{ found: number }>()
  if (unfinished) {
    return errorResponse('导入内容尚未全部上传完成', 409)
  }
  const active = await ensureActiveHistory(c.env, user.id)
  const nextRevision = imported.base_revision + 1
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE cloud_history SET generation = ?, revision = revision + 1
       WHERE user_id = ? AND generation = ? AND revision = ?
         AND EXISTS (
           SELECT 1 FROM cloud_imports
           WHERE user_id = ? AND id = ? AND status = 'staging'
             AND generation = ? AND base_revision = ?
         )
         AND (SELECT COUNT(*) FROM chats WHERE user_id = ? AND generation = ?) = ?
         AND NOT EXISTS (
           SELECT 1 FROM cloud_uploads WHERE user_id = ? AND import_id = ? AND status <> 'completed'
         )
         AND ${liveSessionSql}`
    ).bind(
      imported.generation,
      user.id,
      active.generation,
      imported.base_revision,
      user.id,
      id,
      imported.generation,
      imported.base_revision,
      user.id,
      imported.generation,
      body.count,
      user.id,
      id,
      c.get('sessionTokenHash'),
      user.id,
      Date.now()
    ),
    c.env.DB.prepare(
      `UPDATE cloud_imports SET status = 'committed', count = ?, updated_at = ?
       WHERE user_id = ? AND id = ? AND status = 'staging'
         AND changes() = 1`
    ).bind(body.count, Date.now(), user.id, id),
    c.env.DB.prepare(
      `UPDATE chats SET revision = ?
       WHERE user_id = ? AND generation = ?
         AND changes() = 1
         AND EXISTS (
           SELECT 1 FROM cloud_history
           WHERE user_id = ? AND generation = ? AND revision = ?
         )`
    ).bind(nextRevision, user.id, imported.generation, user.id, imported.generation, nextRevision),
  ])
  if (results[0].meta.changes === 0) {
    const live = await c.env.DB.prepare(`SELECT ${liveSessionSql} AS live`)
      .bind(c.get('sessionTokenHash'), user.id, Date.now())
      .first<{ live: number }>()
    if (!live?.live) {
      return errorResponse('登录状态已变更，请重新登录', 401)
    }
    return errorResponse('账号历史已在其他设备更新，请重新开始导入', 409)
  }
  if (results[1].meta.changes === 0) {
    return errorResponse('导入任务状态已变化', 409)
  }
  await notifyHistoryChange(c.env, user.id)
  const listed = await listActiveChats(c.env, user.id)
  await cleanupExpiredGenerations(c.env, user.id)
  return jsonResponse({
    sessions: listed.sessions,
    generation: listed.generation,
    revision: listed.revision,
    count: results[2].meta.changes,
  })
})

cloudStorageRoutes.post('/storage/uploads', async (c) => {
  const user = c.get('user')
  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('请求内容不是有效 JSON')
  }
  if (!isRecord(body) || (body.kind !== 'chat' && body.kind !== 'file') || !isValidId(body.id)) {
    return errorResponse('上传类型或资源 ID 无效')
  }

  const active = await ensureActiveHistory(c.env, user.id)
  let generation: string | null = null
  let expectedRevision: number | null = null
  let importId: string | null = null
  let summaryJson: string | null = null
  let filesJson = '[]'
  let mimeType: string | null = null

  if (body.importId !== undefined) {
    if (!isValidId(body.importId)) {
      return errorResponse('导入任务 ID 无效')
    }
    const imported = await getImport(c.env, user.id, body.importId)
    if (!imported || imported.status !== 'staging') {
      return errorResponse('导入任务不存在或已经结束', 409)
    }
    importId = imported.id
    generation = imported.generation
    expectedRevision = imported.base_revision
    if (
      (body.generation !== undefined && body.generation !== generation) ||
      (body.expectedRevision !== undefined && body.expectedRevision !== expectedRevision)
    ) {
      return errorResponse('上传版本与导入任务不一致', 409)
    }
  } else {
    generation =
      body.generation === undefined
        ? active.generation
        : isGeneration(body.generation)
          ? body.generation
          : null
    if (generation === null) {
      return errorResponse('generation 无效')
    }
  }

  if (body.kind === 'chat') {
    if (
      body.summary !== undefined &&
      (!isRecord(body.summary) ||
        body.summary.id !== body.id ||
        typeof body.summary.title !== 'string' ||
        !isTimestamp(body.summary.createdAt) ||
        !isTimestamp(body.summary.updatedAt) ||
        body.summary.updatedAt < body.summary.createdAt)
    ) {
      return errorResponse('会话摘要无效')
    }
    if (
      body.files !== undefined &&
      (!Array.isArray(body.files) || !body.files.every((fileId) => isValidId(fileId)))
    ) {
      return errorResponse('文件引用列表无效')
    }
    if (
      isRecord(body.summary) &&
      body.summary.pinned !== undefined &&
      typeof body.summary.pinned !== 'boolean'
    ) {
      return errorResponse('会话置顶状态无效')
    }
    if (importId === null) {
      if (body.expectedRevision !== undefined && !isChatRevision(body.expectedRevision)) {
        return errorResponse('expectedRevision 无效')
      }
      if (body.expectedRevision === undefined) {
        const existing = await c.env.DB.prepare(
          `SELECT revision FROM chats
           WHERE user_id = ? AND generation = ? AND id = ?`
        )
          .bind(user.id, generation, body.id)
          .first<{ revision: number }>()
        expectedRevision = existing?.revision ?? 0
      } else {
        expectedRevision = body.expectedRevision
      }
    }
    // 正文是摘要和引用的唯一来源；初始化 metadata 不复制到有 2 MiB 行上限的 D1。
    summaryJson = null
    filesJson = '[]'
  } else {
    if (
      typeof body.mimeType !== 'string' ||
      body.mimeType.trim().length === 0 ||
      body.mimeType.length > MAX_MIME_TYPE_LENGTH ||
      /[\r\n]/.test(body.mimeType)
    ) {
      return errorResponse('文件类型无效')
    }
    mimeType = body.mimeType.trim()
  }

  const uploadId = crypto.randomUUID()
  const key = `${user.id}/uploads/${uploadId}`
  const multipart = await c.env.FILES.createMultipartUpload(key, {
    httpMetadata: {
      contentType: body.kind === 'file' ? (mimeType as string) : 'application/json; charset=utf-8',
    },
    customMetadata: { user_id: user.id, upload_id: uploadId, kind: body.kind },
  })
  try {
    const inserted = await c.env.DB.prepare(
      `INSERT INTO cloud_uploads
         (user_id, id, kind, object_id, generation, import_id, base_revision,
          r2_key, multipart_id, summary_json, files_json, mime_type, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?
       WHERE ? IS NULL OR EXISTS (
         SELECT 1 FROM cloud_imports
         WHERE user_id = ? AND id = ? AND generation = ? AND status = 'staging'
       )`
    )
      .bind(
        user.id,
        uploadId,
        body.kind,
        body.id,
        generation,
        importId,
        expectedRevision,
        key,
        multipart.uploadId,
        summaryJson,
        filesJson,
        mimeType,
        Date.now(),
        Date.now(),
        importId,
        user.id,
        importId,
        generation
      )
      .run()
    if (inserted.meta.changes === 0) {
      await multipart.abort()
      return errorResponse('导入任务已经结束，无法创建上传', 409)
    }
  } catch (error) {
    await multipart.abort()
    throw error
  }
  return jsonResponse({ id: uploadId }, 201)
})

cloudStorageRoutes.put('/storage/uploads/:id/parts/:part', async (c) => {
  const user = c.get('user')
  const uploadId = c.req.param('id')
  const partNumber = Number(c.req.param('part'))
  if (!isValidId(uploadId) || !Number.isSafeInteger(partNumber) || partNumber < 1) {
    return errorResponse('上传任务或分片序号无效')
  }
  const upload = await c.env.DB.prepare(
    `SELECT id, r2_key, multipart_id, import_id, status FROM cloud_uploads
     WHERE user_id = ? AND id = ?`
  )
    .bind(user.id, uploadId)
    .first<Pick<UploadRow, 'id' | 'r2_key' | 'multipart_id' | 'import_id' | 'status'>>()
  if (!upload) {
    return errorResponse('上传任务不存在', 404)
  }
  if (upload.status !== 'uploading') {
    return errorResponse('上传任务当前不可写入分片', 409)
  }
  if (upload.import_id !== null) {
    const imported = await getImport(c.env, user.id, upload.import_id)
    if (imported?.status !== 'staging') {
      return errorResponse('导入任务已经结束', 409)
    }
  }
  let part: R2UploadedPart
  try {
    const multipart = c.env.FILES.resumeMultipartUpload(upload.r2_key, upload.multipart_id)
    part = await multipart.uploadPart(partNumber, c.req.raw.body ?? new Uint8Array())
  } catch (error) {
    const current = await findUpload(c.env, user.id, uploadId)
    if (!current || current.status !== 'uploading') {
      return errorResponse('上传任务状态已变化', 409)
    }
    if (c.req.raw.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return errorResponse('上传连接已中断', 400)
    }
    throw error
  }
  const now = Date.now()
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO cloud_upload_parts (user_id, upload_id, part_number, etag)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM cloud_uploads
         WHERE user_id = ? AND id = ? AND status = 'uploading'
       )
       ON CONFLICT(user_id, upload_id, part_number) DO UPDATE SET etag = excluded.etag`
    ).bind(user.id, uploadId, part.partNumber, part.etag, user.id, uploadId),
    c.env.DB.prepare(
      `UPDATE cloud_uploads SET updated_at = ?
       WHERE user_id = ? AND id = ? AND status = 'uploading'`
    ).bind(now, user.id, uploadId),
  ]
  if (upload.import_id !== null) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE cloud_imports SET updated_at = ?
         WHERE user_id = ? AND id = ? AND status = 'staging'`
      ).bind(now, user.id, upload.import_id)
    )
  }
  const results = await c.env.DB.batch(statements)
  if (results[1].meta.changes === 0) {
    return errorResponse('上传任务状态已变化', 409)
  }
  if (upload.import_id !== null && results[2]?.meta.changes === 0) {
    return errorResponse('导入任务已经结束', 409)
  }
  return jsonResponse({ partNumber: part.partNumber, etag: part.etag })
})

const validateCompletedParts = async (
  env: AppEnv['Bindings'],
  userId: string,
  uploadId: string,
  count: number
): Promise<UploadedPartRow[] | null> => {
  const rows = await env.DB.prepare(
    `SELECT part_number, etag FROM cloud_upload_parts
     WHERE user_id = ? AND upload_id = ? ORDER BY part_number ASC`
  )
    .bind(userId, uploadId)
    .all<UploadedPartRow>()
  if (
    rows.results.length !== count ||
    rows.results.some((row, index) => row.part_number !== index + 1)
  ) {
    return null
  }
  return rows.results
}

type PublishResult =
  | {
      kind: 'ok'
      summary?: SessionSummary
      file?: { id: string; mimeType: string }
      generation: string | null
      revision: number | null
      createdReferences: string[]
    }
  | { kind: 'conflict'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'invalid'; message: string }

const publishUpload = async (
  env: AppEnv['Bindings'],
  user: UserRow,
  sessionTokenHash: string,
  upload: UploadRow,
  size: number
): Promise<PublishResult> => {
  if (upload.kind === 'file') {
    const previous = await env.DB.prepare('SELECT r2_key FROM files WHERE user_id = ? AND id = ?')
      .bind(user.id, upload.object_id)
      .first<{ r2_key: string }>()
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (user_id, id, r2_key, mime_type, size, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${liveSessionSql}
           AND EXISTS (
             SELECT 1 FROM cloud_uploads
             WHERE user_id = ? AND id = ? AND status = 'completing'
           )
           AND (
             (? IS NOT NULL AND EXISTS (
               SELECT 1 FROM cloud_imports
               WHERE user_id = ? AND id = ? AND generation = ? AND status = 'staging'
             ))
             OR (? IS NULL AND EXISTS (
               SELECT 1 FROM cloud_history
               WHERE user_id = ? AND generation = ?
             ))
           )
         ON CONFLICT(user_id, id) DO UPDATE SET
           r2_key = excluded.r2_key,
           mime_type = excluded.mime_type,
           size = excluded.size`
      ).bind(
        user.id,
        upload.object_id,
        upload.r2_key,
        upload.mime_type,
        size,
        Date.now(),
        sessionTokenHash,
        user.id,
        Date.now(),
        user.id,
        upload.id,
        upload.import_id,
        user.id,
        upload.import_id,
        upload.generation,
        upload.import_id,
        user.id,
        upload.generation
      ),
      env.DB.prepare(
        `UPDATE cloud_uploads
         SET status = 'completed', completed_revision = NULL, updated_at = ?
         WHERE user_id = ? AND id = ? AND status = 'completing' AND changes() = 1`
      ).bind(Date.now(), user.id, upload.id),
    ])
    if (results[0].meta.changes === 0) {
      return { kind: 'unauthorized', message: '登录状态已变更，请重新登录' }
    }
    if (results[1].meta.changes === 0) {
      return { kind: 'conflict', message: '上传任务状态已变化' }
    }
    if (
      previous?.r2_key &&
      previous.r2_key !== upload.r2_key &&
      isScopedR2Key(user.id, previous.r2_key)
    ) {
      try {
        await env.FILES.delete(previous.r2_key)
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('旧文件对象清理失败，将在后台清理中重试', error)
      }
    }
    return {
      kind: 'ok',
      file: { id: upload.object_id, mimeType: upload.mime_type as string },
      generation: null,
      revision: null,
      createdReferences: [],
    }
  }

  if (!upload.generation || upload.base_revision === null) {
    return { kind: 'invalid', message: '会话上传信息不完整' }
  }
  const object = await env.FILES.get(upload.r2_key)
  if (!object) {
    return { kind: 'invalid', message: '上传正文不存在' }
  }
  let storedSession: JsonRecord
  let storedText: string
  try {
    storedText = await object.text()
    const parsed = JSON.parse(storedText) as unknown
    if (!isRecord(parsed)) {
      return { kind: 'invalid', message: '上传正文必须是 JSON 对象' }
    }
    storedSession = parsed
  } catch {
    return { kind: 'invalid', message: '上传正文不是有效 JSON' }
  }
  if (
    storedSession.id !== upload.object_id ||
    typeof storedSession.title !== 'string' ||
    !isTimestamp(storedSession.createdAt) ||
    !isTimestamp(storedSession.updatedAt) ||
    storedSession.updatedAt < storedSession.createdAt ||
    !Array.isArray(storedSession.messages) ||
    (storedSession.pinned !== undefined && typeof storedSession.pinned !== 'boolean')
  ) {
    return { kind: 'invalid', message: '上传正文中的会话摘要无效' }
  }
  const summary: JsonRecord = {
    id: storedSession.id,
    title: storedSession.title,
    createdAt: storedSession.createdAt,
    updatedAt: storedSession.updatedAt,
    pinned: storedSession.pinned === true,
  }
  const files = fileIdsFromSession(storedSession)
  const mimeTypes = new Map<string, string>()
  for (let offset = 0; offset < files.length; offset += 500) {
    const chunk = files.slice(offset, offset + 500)
    const storedFiles = await env.DB.prepare(
      `SELECT id, mime_type FROM files
       WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`
    )
      .bind(user.id, JSON.stringify(chunk))
      .all<{ id: string; mime_type: string }>()
    for (const row of storedFiles.results) {
      mimeTypes.set(row.id, row.mime_type)
    }
  }
  let enriched = false
  for (const message of storedSession.messages) {
    if (!isRecord(message) || !Array.isArray(message.files)) {
      continue
    }
    for (const file of message.files) {
      if (
        isRecord(file) &&
        typeof file.id === 'string' &&
        (!file.mimeType || file.mimeType === '') &&
        mimeTypes.has(file.id)
      ) {
        file.mimeType = mimeTypes.get(file.id)
        enriched = true
      }
    }
  }
  if (enriched) {
    const body = JSON.stringify(storedSession)
    if (body !== storedText) {
      await env.FILES.put(upload.r2_key, body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      })
    }
  }
  const pinned = summary.pinned === true ? 1 : 0
  await stageChatReferences(env, user.id, upload.r2_key, files)

  if (upload.import_id !== null) {
    const imported = await getImport(env, user.id, upload.import_id)
    if (
      !imported ||
      imported.status !== 'staging' ||
      imported.generation !== upload.generation ||
      imported.base_revision !== upload.base_revision
    ) {
      return { kind: 'conflict', message: '导入任务不在暂存状态，无法发布会话' }
    }
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO chats
           (user_id, generation, id, revision, title, pinned,
            created_at, updated_at, data_json, body_key)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?
         WHERE EXISTS (
           SELECT 1 FROM cloud_imports
           WHERE user_id = ? AND id = ? AND status = 'staging' AND generation = ?
         )
         AND EXISTS (
           SELECT 1 FROM cloud_uploads
           WHERE user_id = ? AND id = ? AND status = 'completing'
         )
         ON CONFLICT(user_id, generation, id) DO UPDATE SET
           revision = excluded.revision,
           title = excluded.title,
           pinned = excluded.pinned,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           data_json = '{}',
           body_key = excluded.body_key`
      ).bind(
        user.id,
        upload.generation,
        upload.object_id,
        upload.base_revision,
        summary.title,
        pinned,
        summary.createdAt,
        summary.updatedAt,
        upload.r2_key,
        user.id,
        upload.import_id,
        upload.generation,
        user.id,
        upload.id
      ),
      env.DB.prepare(
        `DELETE FROM chat_files
         WHERE user_id = ? AND generation = ? AND chat_id = ?
           AND EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
           )`
      ).bind(
        user.id,
        upload.generation,
        upload.object_id,
        user.id,
        upload.generation,
        upload.object_id,
        upload.r2_key
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO chat_files (user_id, generation, chat_id, file_id)
         SELECT ?, ?, ?, file_id FROM cloud_chat_refs
         WHERE user_id = ? AND body_key = ?
           AND EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
           )`
      ).bind(
        user.id,
        upload.generation,
        upload.object_id,
        user.id,
        upload.r2_key,
        user.id,
        upload.generation,
        upload.object_id,
        upload.r2_key
      ),
      env.DB.prepare(
        `UPDATE cloud_imports SET count = (
           SELECT COUNT(*) FROM chats WHERE user_id = ? AND generation = ?
         ), updated_at = ?
         WHERE user_id = ? AND id = ? AND status = 'staging'`
      ).bind(user.id, upload.generation, Date.now(), user.id, upload.import_id),
      env.DB.prepare(
        `UPDATE cloud_uploads
         SET status = 'completed', completed_revision = ?, summary_json = ?, updated_at = ?
         WHERE user_id = ? AND id = ? AND status = 'completing'
           AND EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
           )`
      ).bind(
        upload.base_revision,
        JSON.stringify(summary),
        Date.now(),
        user.id,
        upload.id,
        user.id,
        upload.generation,
        upload.object_id,
        upload.r2_key
      ),
      env.DB.prepare(
        `DELETE FROM cloud_chat_refs
         WHERE user_id = ? AND body_key = ?
           AND EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
           )`
      ).bind(user.id, upload.r2_key, user.id, upload.generation, upload.object_id, upload.r2_key),
    ])
    if (results[0].meta.changes === 0) {
      return { kind: 'conflict', message: '导入任务状态已变化' }
    }
    if (results[4].meta.changes === 0) {
      return { kind: 'conflict', message: '上传任务状态已变化' }
    }
    return {
      kind: 'ok',
      summary: {
        id: upload.object_id,
        title: summary.title as string,
        createdAt: summary.createdAt as number,
        updatedAt: summary.updatedAt as number,
        pinned: pinned === 1,
        revision: upload.base_revision,
        generation: upload.generation,
      },
      generation: upload.generation,
      revision: upload.base_revision,
      createdReferences: files,
    }
  }

  const nextRevision = upload.base_revision + 1
  const chatStatement =
    upload.base_revision === 0
      ? env.DB.prepare(
          `INSERT INTO chats
             (user_id, generation, id, revision, title, pinned,
              created_at, updated_at, data_json, body_key)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?
           WHERE changes() = 1 AND ${liveSessionSql}
             AND NOT EXISTS (
               SELECT 1 FROM chats
               WHERE user_id = ? AND generation = ? AND id = ?
             )
           ON CONFLICT(user_id, generation, id) DO NOTHING`
        ).bind(
          user.id,
          upload.generation,
          upload.object_id,
          nextRevision,
          summary.title,
          pinned,
          summary.createdAt,
          summary.updatedAt,
          upload.r2_key,
          sessionTokenHash,
          user.id,
          Date.now(),
          user.id,
          upload.generation,
          upload.object_id
        )
      : env.DB.prepare(
          `UPDATE chats
           SET revision = ?, title = ?, pinned = ?, created_at = ?, updated_at = ?,
               data_json = '{}', body_key = ?
           WHERE user_id = ? AND generation = ? AND id = ? AND revision = ?
             AND changes() = 1 AND ${liveSessionSql}`
        ).bind(
          nextRevision,
          summary.title,
          pinned,
          summary.createdAt,
          summary.updatedAt,
          upload.r2_key,
          user.id,
          upload.generation,
          upload.object_id,
          upload.base_revision,
          sessionTokenHash,
          user.id,
          Date.now()
        )
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE cloud_history SET revision = revision + 1
       WHERE user_id = ? AND generation = ? AND ${liveSessionSql}
         AND EXISTS (
           SELECT 1 FROM cloud_uploads
           WHERE user_id = ? AND id = ? AND status = 'completing'
         )
         AND (
           (? = 0 AND NOT EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ?
           ))
           OR EXISTS (
             SELECT 1 FROM chats
             WHERE user_id = ? AND generation = ? AND id = ? AND revision = ?
           )
         )`
    ).bind(
      user.id,
      upload.generation,
      sessionTokenHash,
      user.id,
      Date.now(),
      user.id,
      upload.id,
      upload.base_revision,
      user.id,
      upload.generation,
      upload.object_id,
      user.id,
      upload.generation,
      upload.object_id,
      upload.base_revision
    ),
    chatStatement,
    env.DB.prepare(
      `DELETE FROM chat_files
       WHERE user_id = ? AND generation = ? AND chat_id = ?
         AND EXISTS (
           SELECT 1 FROM chats
           WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
         )`
    ).bind(
      user.id,
      upload.generation,
      upload.object_id,
      user.id,
      upload.generation,
      upload.object_id,
      upload.r2_key
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO chat_files (user_id, generation, chat_id, file_id)
       SELECT ?, ?, ?, file_id FROM cloud_chat_refs
       WHERE user_id = ? AND body_key = ?
         AND EXISTS (
           SELECT 1 FROM chats
           WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
         )`
    ).bind(
      user.id,
      upload.generation,
      upload.object_id,
      user.id,
      upload.r2_key,
      user.id,
      upload.generation,
      upload.object_id,
      upload.r2_key
    ),
    env.DB.prepare(
      `UPDATE cloud_uploads
       SET status = 'completed', completed_revision = ?, summary_json = ?, updated_at = ?
       WHERE user_id = ? AND id = ? AND status = 'completing'
         AND EXISTS (
           SELECT 1 FROM chats
           WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
         )`
    ).bind(
      nextRevision,
      JSON.stringify(summary),
      Date.now(),
      user.id,
      upload.id,
      user.id,
      upload.generation,
      upload.object_id,
      upload.r2_key
    ),
    env.DB.prepare(
      `DELETE FROM cloud_chat_refs
       WHERE user_id = ? AND body_key = ?
         AND EXISTS (
           SELECT 1 FROM chats
           WHERE user_id = ? AND generation = ? AND id = ? AND body_key = ?
         )`
    ).bind(user.id, upload.r2_key, user.id, upload.generation, upload.object_id, upload.r2_key),
  ])
  if (results[0].meta.changes === 0) {
    const live = await env.DB.prepare(`SELECT ${liveSessionSql} AS live`)
      .bind(sessionTokenHash, user.id, Date.now())
      .first<{ live: number }>()
    return live?.live
      ? { kind: 'conflict', message: '会话已在其他设备更新，请重新加载后上传' }
      : { kind: 'unauthorized', message: '登录状态已变更，请重新登录' }
  }
  if (results[1].meta.changes === 0) {
    const live = await env.DB.prepare(`SELECT ${liveSessionSql} AS live`)
      .bind(sessionTokenHash, user.id, Date.now())
      .first<{ live: number }>()
    return live?.live
      ? { kind: 'conflict', message: '会话已在其他设备更新，请重新加载后上传' }
      : { kind: 'unauthorized', message: '登录状态已变更，请重新登录' }
  }
  if (results[4].meta.changes === 0) {
    return { kind: 'conflict', message: '上传任务状态已变化' }
  }
  const history = await ensureActiveHistory(env, user.id)
  return {
    kind: 'ok',
    summary: {
      id: upload.object_id,
      title: summary.title as string,
      createdAt: summary.createdAt as number,
      updatedAt: summary.updatedAt as number,
      pinned: pinned === 1,
      revision: nextRevision,
      generation: upload.generation,
    },
    generation: upload.generation,
    revision: history.revision,
    createdReferences: files,
  }
}

const findUpload = async (
  env: AppEnv['Bindings'],
  userId: string,
  id: string
): Promise<UploadRow | null> =>
  env.DB.prepare(
    `SELECT id, kind, object_id, generation, import_id, base_revision,
            r2_key, multipart_id, summary_json, files_json, mime_type,
            completed_revision, status
     FROM cloud_uploads WHERE user_id = ? AND id = ?`
  )
    .bind(userId, id)
    .first<UploadRow>()

cloudStorageRoutes.post('/storage/uploads/:id/complete', async (c) => {
  const user = c.get('user')
  const uploadId = c.req.param('id')
  let body: unknown
  try {
    body = await readJson(c.req.raw)
  } catch {
    return errorResponse('请求内容不是有效 JSON')
  }
  if (
    !isRecord(body) ||
    typeof body.parts !== 'number' ||
    !Number.isSafeInteger(body.parts) ||
    body.parts < 1
  ) {
    return errorResponse('parts 必须是正整数')
  }
  const upload = await findUpload(c.env, user.id, uploadId)
  if (!upload) {
    return errorResponse('上传任务不存在', 404)
  }
  if (upload.status === 'completed') {
    const summary =
      upload.kind === 'chat' && upload.summary_json
        ? (JSON.parse(upload.summary_json) as JsonRecord)
        : null
    const chatRevision = upload.completed_revision
    const history = upload.generation ? await ensureActiveHistory(c.env, user.id) : null
    return jsonResponse({
      ...(summary
        ? {
            summary: {
              ...summary,
              revision: chatRevision,
              generation: upload.generation,
            },
          }
        : {}),
      ...(upload.kind === 'file'
        ? { file: { id: upload.object_id, mimeType: upload.mime_type } }
        : {}),
      ...(upload.generation ? { generation: upload.generation } : {}),
      ...(history ? { revision: history.revision } : {}),
    })
  }
  if (upload.status !== 'uploading') {
    return errorResponse('上传任务当前不可完成', 409)
  }
  const parts = await validateCompletedParts(c.env, user.id, uploadId, body.parts)
  if (!parts) {
    return errorResponse('上传分片不连续或数量不一致', 409)
  }
  const claimed = await c.env.DB.prepare(
    `UPDATE cloud_uploads SET status = 'completing', updated_at = ?
     WHERE user_id = ? AND id = ? AND status = 'uploading'`
  )
    .bind(Date.now(), user.id, uploadId)
    .run()
  if (claimed.meta.changes === 0) {
    return errorResponse('上传任务状态已变化', 409)
  }

  try {
    const multipart = c.env.FILES.resumeMultipartUpload(upload.r2_key, upload.multipart_id)
    const object = await multipart.complete(
      parts.map((part) => ({ partNumber: part.part_number, etag: part.etag }))
    )
    const published = await publishUpload(
      c.env,
      user,
      c.get('sessionTokenHash'),
      upload,
      object.size
    )
    if (published.kind !== 'ok') {
      const current = await findUpload(c.env, user.id, uploadId)
      const status =
        published.kind === 'unauthorized' ? 401 : published.kind === 'invalid' ? 400 : 409
      await deleteStagedChatReferences(c.env, user.id, upload.r2_key)
      await c.env.DB.prepare(
        `UPDATE cloud_uploads SET status = 'failed', updated_at = ?
         WHERE user_id = ? AND id = ? AND status = 'completing'`
      )
        .bind(Date.now(), user.id, uploadId)
        .run()
      await c.env.FILES.delete(upload.r2_key)
      if (!current || current.status === 'cancelled') {
        return errorResponse('上传任务已取消', 409)
      }
      return errorResponse(published.message, status)
    }
    try {
      await deleteStagedChatReferences(c.env, user.id, upload.r2_key)
      await c.env.DB.prepare('DELETE FROM cloud_upload_parts WHERE user_id = ? AND upload_id = ?')
        .bind(user.id, uploadId)
        .run()
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('已完成上传的分片索引清理失败，将在后台清理中重试', error)
    }
    if (upload.kind === 'chat' && upload.import_id === null) {
      await notifyHistoryChange(c.env, user.id)
    }
    return jsonResponse({
      ...(published.summary ? { summary: published.summary } : {}),
      ...(published.file ? { file: published.file } : {}),
      ...(published.generation ? { generation: published.generation } : {}),
      ...(published.revision ? { revision: published.revision } : {}),
    })
  } catch (error) {
    const current = await findUpload(c.env, user.id, uploadId)
    if (!current || current.status === 'cancelled') {
      if (
        isScopedR2Key(user.id, upload.r2_key) &&
        !(await isR2KeyReferenced(c.env, user.id, upload.r2_key))
      ) {
        await c.env.FILES.delete(upload.r2_key)
      }
      await deleteStagedChatReferences(c.env, user.id, upload.r2_key)
      return errorResponse('上传任务已取消', 409)
    }
    if (current?.status === 'completed') {
      const currentSummary =
        current.kind === 'chat' && current.summary_json
          ? (JSON.parse(current.summary_json) as JsonRecord)
          : null
      const history = current.generation ? await ensureActiveHistory(c.env, user.id) : null
      return jsonResponse({
        ...(currentSummary
          ? {
              summary: {
                ...currentSummary,
                revision: current.completed_revision,
                generation: current.generation,
              },
            }
          : {}),
        ...(current.kind === 'file'
          ? { file: { id: current.object_id, mimeType: current.mime_type } }
          : {}),
        ...(current.generation ? { generation: current.generation } : {}),
        ...(history ? { revision: history.revision } : {}),
      })
    }
    try {
      await c.env.DB.prepare(
        `UPDATE cloud_uploads SET status = 'failed', updated_at = ?
         WHERE user_id = ? AND id = ? AND status = 'completing'`
      )
        .bind(Date.now(), user.id, uploadId)
        .run()
      await c.env.FILES.delete(upload.r2_key)
    } catch (cleanupError) {
      // eslint-disable-next-line no-console
      console.warn('失败上传状态记录未完成，将在后台清理中重试', cleanupError)
    }
    throw error
  }
})

cloudStorageRoutes.get('/storage/uploads/:id', async (c) => {
  const user = c.get('user')
  const upload = await findUpload(c.env, user.id, c.req.param('id'))
  if (!upload) {
    return errorResponse('上传任务不存在', 404)
  }
  let summary: JsonRecord | null = null
  if (upload.kind === 'chat' && upload.summary_json) {
    try {
      summary = JSON.parse(upload.summary_json) as JsonRecord
    } catch {
      return errorResponse('上传任务摘要损坏', 500)
    }
    summary = {
      ...summary,
      ...(upload.completed_revision === null ? {} : { revision: upload.completed_revision }),
      generation: upload.generation,
    }
  }
  const history = upload.generation ? await ensureActiveHistory(c.env, user.id) : null
  return jsonResponse({
    status: upload.status,
    ...(summary ? { summary } : {}),
    ...(upload.kind === 'file'
      ? { file: { id: upload.object_id, mimeType: upload.mime_type } }
      : {}),
    ...(upload.generation ? { generation: upload.generation } : {}),
    ...(history ? { revision: history.revision } : {}),
  })
})

cloudStorageRoutes.delete('/storage/uploads/:id', async (c) => {
  const user = c.get('user')
  const uploadId = c.req.param('id')
  const upload = await findUpload(c.env, user.id, uploadId)
  if (!upload) {
    return errorResponse('上传任务不存在', 404)
  }
  if (upload.status === 'completed') {
    return errorResponse('上传任务已经完成，无法取消', 409)
  }
  if (upload.status === 'cancelled') {
    await cleanupCancelledUpload(c.env, user.id, upload)
    return noContent()
  }
  if (upload.status === 'completing') {
    return errorResponse('上传正文正在发布，当前无法取消', 409)
  }
  const claimed = await c.env.DB.prepare(
    `UPDATE cloud_uploads SET status = 'cancelled', updated_at = ?
     WHERE user_id = ? AND id = ? AND status IN ('uploading', 'failed')`
  )
    .bind(Date.now(), user.id, uploadId)
    .run()
  if (claimed.meta.changes === 0) {
    const latest = await findUpload(c.env, user.id, uploadId)
    if (latest?.status === 'cancelled') {
      return noContent()
    }
    return errorResponse('上传正文正在发布或已经完成，当前无法取消', 409)
  }
  await cleanupCancelledUpload(c.env, user.id, upload)
  return noContent()
})

export const publishChatUpload = async (
  env: AppEnv['Bindings'],
  user: UserRow,
  uploadId: string
): Promise<Response> => {
  const upload = await findUpload(env, user.id, uploadId)
  if (!upload || upload.kind !== 'chat') {
    return errorResponse('会话上传任务不存在', 404)
  }
  if (upload.status !== 'completed') {
    return errorResponse('会话上传尚未完成', 409)
  }
  const summary =
    upload.summary_json === null ? null : (JSON.parse(upload.summary_json) as JsonRecord)
  if (!summary) {
    return errorResponse('会话上传摘要缺失', 500)
  }
  const chatRevision = upload.completed_revision
  const history = upload.generation ? await ensureActiveHistory(env, user.id) : null
  return jsonResponse({
    summary: {
      ...summary,
      revision: chatRevision,
      generation: upload.generation,
    },
    ...(upload.generation ? { generation: upload.generation } : {}),
    ...(history ? { revision: history.revision } : {}),
  })
}
