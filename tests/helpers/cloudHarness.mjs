import { readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ENTRY = `
  export { app } from './server/index.ts'
  export { cleanupAbandonedStorage } from './server/cloudStorage.ts'
  export { sha256, hashPassword } from './server/security.ts'
  export * as backup from './src/services/chat/backup.ts'
  export * as db from './src/services/chat/db.ts'
  export * as store from './src/services/chat/store.ts'
  export * as backend from './src/services/backend.ts'
  export * as importProgress from './src/services/chat/importProgress.ts'
  export * as schema from './src/services/chat/history/schema.ts'
  export * as paths from './src/services/chat/history/paths.ts'
  export { toLocalSession } from './src/services/chat/history/toLocal.ts'
  export { writeArchive } from './src/services/chat/history/zipWriter.ts'
  export { readArchive, readEntry, skipEntry } from './src/services/chat/history/zipReader.ts'
`

const OUTPUT = `test-results/cloudHarness-${process.pid}.mjs`
let buildPromise
let freshSequence = 0

/** 构建测试使用的同一份 app 与前端模块，避免测试分别打包出不一致的实现。 */
export const buildCloudTestModules = () => {
  buildPromise ??= (async () => {
    mkdirSync('test-results', { recursive: true })
    await build({
      stdin: {
        contents: ENTRY,
        resolveDir: process.cwd(),
        sourcefile: 'cloud-harness-entry.ts',
        loader: 'ts',
      },
      outfile: OUTPUT,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
    })
    process.once('exit', () => {
      try {
        unlinkSync(OUTPUT)
      } catch {
        // 进程被强制终止时由被忽略的 test-results 清理残留。
      }
    })
    return import(pathToFileURL(`${process.cwd()}/${OUTPUT}`).href)
  })()
  return buildPromise
}

const toBytes = async (value) => {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value)
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0))
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer())
  }
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer())
  }
  if (typeof value === 'string') {
    return new TextEncoder().encode(value)
  }
  return new Uint8Array(value)
}

/** 使用真实 SQLite 验证 D1 SQL、约束和 batch 回滚，迁移目录按文件名全部执行。 */
export class LocalD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:')
    this.trace = []
    this.failures = []
    for (const file of readdirSync('migrations')
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      this.db.exec(readFileSync(`migrations/${file}`, 'utf8'))
    }
  }

  beforeExecute

  failNext(matcher, error = new Error('injected D1 failure')) {
    const matches =
      matcher instanceof RegExp
        ? (sql) => matcher.test(sql)
        : typeof matcher === 'function'
          ? matcher
          : (sql) => sql.includes(matcher)
    this.failures.push({ matches, error })
  }

  prepare(sql) {
    const execute = (params, kind) => {
      this.trace.push({ sql, params })
      const failureIndex = this.failures.findIndex((failure) => failure.matches(sql, params))
      if (failureIndex !== -1) {
        const [{ error }] = this.failures.splice(failureIndex, 1)
        throw error
      }
      this.beforeExecute?.(sql, params)
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
      const results = []
      for (const statement of statements) {
        results.push(await statement.run())
      }
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.db.close()
  }
}

/** R2 替身保留分片、可恢复 multipart、head/get 和可读正文，覆盖上传恢复路径。 */
export class LocalR2 {
  objects = new Map()
  multipartUploads = new Map()
  sequence = 0
  beforePut
  beforeUploadPart
  beforeComplete
  afterPut

  objectRecord(key, stored) {
    const copy = () => new Uint8Array(stored.bytes)
    return {
      key,
      body: copy(),
      size: stored.bytes.byteLength,
      etag: stored.etag ?? `object-${stored.bytes.byteLength}`,
      uploaded: stored.uploaded ?? new Date(),
      httpMetadata: stored.options?.httpMetadata,
      customMetadata: stored.options?.customMetadata,
      text: async () => new TextDecoder().decode(stored.bytes),
      arrayBuffer: async () => copy().buffer,
      blob: async () => new Blob([copy()], { type: stored.options?.httpMetadata?.contentType }),
    }
  }

  async put(key, value, options) {
    const bytes = await toBytes(value)
    await this.beforePut?.(key, bytes, options)
    this.objects.set(key, { bytes, options, uploaded: new Date() })
    await this.afterPut?.(key)
    return { size: bytes.byteLength, key }
  }

  async head(key) {
    const stored = this.objects.get(key)
    return stored ? this.objectRecord(key, stored) : null
  }

  async get(key) {
    const stored = this.objects.get(key)
    return stored ? this.objectRecord(key, stored) : null
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
      objects: selected.map((key) => ({
        key,
        size: this.objects.get(key).bytes.byteLength,
      })),
      truncated,
      ...(truncated ? { cursor: String(offset + selected.length) } : {}),
    }
  }

  async createMultipartUpload(key, options) {
    const uploadId = `multipart-${++this.sequence}`
    this.multipartUploads.set(uploadId, { key, options, parts: new Map() })
    return this.multipartHandle(key, uploadId)
  }

  resumeMultipartUpload(key, uploadId) {
    const stored = this.multipartUploads.get(uploadId)
    if (!stored || stored.key !== key) {
      throw new Error('multipart upload not found')
    }
    return this.multipartHandle(key, uploadId)
  }

  multipartHandle(key, uploadId) {
    const stored = () => {
      const upload = this.multipartUploads.get(uploadId)
      if (!upload || upload.key !== key) {
        throw new Error('multipart upload not found')
      }
      return upload
    }
    return {
      uploadId,
      key,
      uploadPart: async (partNumber, value) => {
        const upload = stored()
        const bytes = await toBytes(value)
        await this.beforeUploadPart?.({ key, uploadId, partNumber, bytes })
        const etag = `part-${partNumber}-${bytes.byteLength}`
        upload.parts.set(partNumber, { bytes, etag })
        return { partNumber, etag }
      },
      complete: async (parts) => {
        const upload = stored()
        const chunks = parts.map((part) => {
          const saved = upload.parts.get(part.partNumber)
          if (!saved || saved.etag !== part.etag) {
            throw new Error(`missing multipart part ${part.partNumber}`)
          }
          return saved.bytes
        })
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        await this.beforeComplete?.({ key, uploadId, bytes })
        this.objects.set(key, {
          bytes,
          options: upload.options,
          uploaded: new Date(),
        })
        this.multipartUploads.delete(uploadId)
        await this.afterPut?.(key)
        return { size, key }
      },
      abort: async () => {
        stored()
        this.multipartUploads.delete(uploadId)
      },
    }
  }
}

/** 测试用同步队列记录服务端提交后的每个通知。 */
export const createFakeSync = () => {
  const notifications = []
  const namespace = {
    idFromName: (id) => id,
    get: (id) => ({
      fetch: async (input, init) => {
        notifications.push({ userId: id, url: String(input), ...init })
        return new Response(null, { status: 204 })
      },
    }),
  }
  return { namespace, notifications }
}

export const iso = (milliseconds = 1) => new Date(milliseconds).toISOString()
export const jsonBlob = (value) => new Blob([JSON.stringify(value)], { type: 'application/json' })
export const toFile = (blob, name = 'deepseek_data.zip') =>
  new File([blob], name, { type: 'application/zip' })

export const chatMessage = ({
  id,
  parentId = null,
  role,
  status = 'FINISHED',
  thinking = role === 'ASSISTANT',
  search = false,
  fragments,
  insertedAt = iso(id),
}) => ({
  id,
  parent_id: parentId,
  role,
  status,
  thinking_enabled: thinking,
  search_enabled: search,
  accumulated_token_usage: 0,
  inserted_at: insertedAt,
  fragments,
})

export const sessionFile = ({
  id,
  title,
  pinned = false,
  currentMessageId,
  messages,
  insertedAt = iso(1),
  updatedAt = iso(messages.length + 1),
}) => ({
  id,
  title,
  pinned,
  current_message_id: currentMessageId ?? messages.at(-1)?.id ?? 0,
  inserted_at: insertedAt,
  updated_at: updatedAt,
  messages,
})

export const indexEntry = (session) => ({
  id: session.id,
  title: session.title,
  pinned: session.pinned,
  message_count: session.messages.length,
  inserted_at: session.inserted_at,
  updated_at: session.updated_at,
})

export const fileReference = (
  modules,
  { sessionId, id, name, bytes, isImage, fileName = name, fileSize }
) => {
  const value = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)
  return {
    entry: {
      id,
      file_name: name,
      file_size: fileSize ?? value.byteLength,
      token_usage: null,
      inserted_at: iso(1),
      export_path: modules.paths.filePath(sessionId, id, fileName),
      is_image: isImage,
      width: null,
      height: null,
    },
    original: {
      name: modules.paths.filePath(sessionId, id, fileName),
      blob: new Blob([value]),
      bytes: value,
    },
  }
}

export const buildArchive = async (
  modules,
  { sessions, originals = [], user = { email: 'masked@example.com' }, originalsFirst = false }
) => {
  const entries = [
    {
      name: modules.paths.MANIFEST_PATH,
      blob: jsonBlob({ export_format_version: 3 }),
    },
  ]
  if (user !== null) {
    entries.push({ name: modules.paths.USER_PATH, blob: jsonBlob(user) })
  }
  if (originalsFirst) {
    entries.push(...originals)
  }
  for (const session of sessions) {
    entries.push({ name: modules.paths.sessionPath(session.id), blob: jsonBlob(session) })
  }
  entries.push({
    name: modules.paths.INDEX_PATH,
    blob: jsonBlob(sessions.map(indexEntry)),
  })
  if (!originalsFirst) {
    entries.push(...originals)
  }
  return modules.writeArchive(entries)
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export const createGate = () => {
  const entered = deferred()
  const released = deferred()
  const enteredTimer = setTimeout(() => {
    entered.reject(new Error('gate was not reached; import failed before the expected request'))
  }, 15_000)
  const releasedTimer = setTimeout(() => {
    released.reject(new Error('gate was not released within 15 seconds'))
  }, 15_000)
  enteredTimer.unref?.()
  releasedTimer.unref?.()
  return {
    entered: entered.promise,
    markEntered: () => {
      clearTimeout(enteredTimer)
      entered.resolve()
    },
    wait: released.promise,
    release: () => {
      clearTimeout(releasedTimer)
      released.resolve()
    },
  }
}

const waitUntil = async (predicate, message = 'condition was not reached') => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

const isJsonResponse = (response) =>
  response.headers.get('content-type')?.includes('application/json') ?? false

/** 每个实例拥有独立 D1、R2、账号、当前身份和请求注入器。 */
export const createCloudHarness = async () => {
  const modules = await buildCloudTestModules()
  const db = new LocalD1()
  const files = new LocalR2()
  const sync = createFakeSync()
  const env = {
    DB: db,
    FILES: files,
    SYNC: sync.namespace,
    ASSETS: {
      fetch: async () =>
        new Response('<html>Deepseek Chat</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    },
    DEEPSEEK_API_KEY: 'sk-test-deployment-secret',
    API_KEY_ENCRYPTION_KEY: 'test-encryption-secret-with-more-than-32-characters',
    ADMIN_USERNAME: 'cloud_admin',
    ADMIN_PASSWORD: 'cloud-admin-password',
  }
  const originalFetch = globalThis.fetch
  const requests = []
  const interceptors = []
  const users = []
  let userSequence = 0
  let currentUser = null
  let disposed = false

  const resolveUser = (value) => {
    if (!value) {
      throw new Error('A test account is required')
    }
    return typeof value === 'string' ? users.find((user) => user.id === value) : value
  }

  const api = async (user, path, { method = 'GET', body, headers = {}, csrf = true } = {}) => {
    const account = resolveUser(user)
    if (!path.startsWith('/api/')) {
      throw new Error(`Backend paths must start with /api/: ${path}`)
    }
    const requestHeaders = new Headers(headers)
    requestHeaders.set('Cookie', account.cookie)
    if (csrf && !['GET', 'HEAD'].includes(method)) {
      requestHeaders.set('X-Requested-With', 'XMLHttpRequest')
    }
    let requestBody = body
    if (
      body !== undefined &&
      body !== null &&
      typeof body === 'object' &&
      !(body instanceof Blob) &&
      !(body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(body) &&
      !(body instanceof FormData) &&
      !(body instanceof ReadableStream)
    ) {
      requestHeaders.set('Content-Type', 'application/json')
      requestBody = JSON.stringify(body)
    }
    return modules.app.request(
      `https://chat.example.com${path}`,
      {
        method,
        headers: requestHeaders,
        body: requestBody,
        ...(requestBody instanceof ReadableStream ? { duplex: 'half' } : {}),
      },
      env
    )
  }

  const fakeFetch = async (input, init = {}) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const url = new URL(raw, 'https://chat.example.com')
    if (url.origin !== 'https://chat.example.com' || !url.pathname.startsWith('/api/')) {
      throw new Error(`Unexpected outbound request: ${url.href}`)
    }
    if (!currentUser) {
      throw new Error('No current test account is selected')
    }
    const requestUser = currentUser
    const method = (init.method ?? 'GET').toUpperCase()
    const requestHeaders = new Headers(init.headers)
    const requestBody = init.body
    const context = {
      path: url.pathname,
      method,
      user: requestUser,
      headers: requestHeaders,
      body: requestBody,
      init,
    }
    const afterResponses = []
    for (const interceptor of [...interceptors]) {
      const action = await interceptor(context)
      if (!action) {
        continue
      }
      if (action.response) {
        requests.push({
          path: context.path,
          method,
          user: requestUser,
          status: action.response.status,
          headers: action.response.headers,
          body: null,
        })
        return action.response
      }
      if (action.error) {
        requests.push({
          path: context.path,
          method,
          user: requestUser,
          status: null,
          headers: new Headers(),
          body: null,
        })
        throw action.error
      }
      if (action.afterResponse) {
        afterResponses.push(action.afterResponse)
      }
    }
    const response = await api(requestUser, context.path, {
      method,
      body: requestBody,
      headers: requestHeaders,
      csrf: false,
    })
    const record = {
      path: context.path,
      method,
      user: requestUser,
      status: response.status,
      headers: response.headers,
      body: null,
    }
    requests.push(record)
    if (isJsonResponse(response)) {
      record.body = await response
        .clone()
        .json()
        .catch(() => null)
    }
    for (const afterResponse of afterResponses) {
      await afterResponse(response)
    }
    return response
  }
  globalThis.fetch = fakeFetch

  const addUser = async (username) => {
    userSequence += 1
    const id = `test-user-${userSequence}-${username.toLowerCase()}`
    const token = `test-session-${userSequence}-${crypto.randomUUID()}`
    const tokenHash = await modules.sha256(token)
    const now = Date.now()
    db.db
      .prepare(
        `INSERT INTO users
         (id, username, password_hash, role, status, created_at, auth_version)
       VALUES (?, ?, NULL, 'user', 'active', ?, 1)`
      )
      .run(id, username.toLowerCase(), now)
    db.db
      .prepare(
        `INSERT INTO auth_sessions
         (token_hash, user_id, expires_at, created_at, auth_version, absolute_expires_at)
       VALUES (?, ?, ?, ?, 1, ?)`
      )
      .run(tokenHash, id, now + 7 * 86_400_000, now, now + 30 * 86_400_000)
    db.db
      .prepare(
        `INSERT INTO cloud_history (user_id, generation, revision)
       VALUES (?, 'legacy', 1)`
      )
      .run(id)
    const user = {
      id,
      username: username.toLowerCase(),
      role: 'user',
      status: 'active',
      token,
      tokenHash,
      cookie: `deepseek_chat_session=${token}`,
    }
    users.push(user)
    return user
  }

  const setCurrentUser = (user, { reset = false } = {}) => {
    currentUser = resolveUser(user)
    modules.backend.setBackendUserId(currentUser.id)
    if (reset) {
      modules.store.resetChatState()
    }
  }

  const createImport = async (user) => {
    const response = await api(user, '/api/chats/imports', {
      method: 'POST',
      body: {},
    })
    const body = await response.json()
    if (response.status !== 201 || !body.id) {
      throw new Error(`Unable to create import task: ${response.status}`)
    }
    return body
  }

  const uploadBlobAs = async (user, metadata, blob) => {
    const account = resolveUser(user)
    const started = await api(account, '/api/storage/uploads', {
      method: 'POST',
      body: metadata,
    })
    const startedBody = await started.json()
    if (started.status !== 201 || !startedBody.id) {
      return { start: started, started: startedBody, complete: null, completed: null }
    }
    const uploadPath = `/api/storage/uploads/${encodeURIComponent(startedBody.id)}`
    const parts = Math.max(1, Math.ceil(blob.size / (8 * 1024 * 1024)))
    for (let part = 1; part <= parts; part++) {
      const response = await api(account, `${uploadPath}/parts/${part}`, {
        method: 'PUT',
        body: blob.slice((part - 1) * 8 * 1024 * 1024, part * 8 * 1024 * 1024),
      })
      if (!response.ok) {
        return { start: started, started: startedBody, part: response, complete: null }
      }
    }
    const complete = await api(account, `${uploadPath}/complete`, {
      method: 'POST',
      body: { parts },
    })
    return {
      start: started,
      started: startedBody,
      uploadPath,
      complete,
      completed: await complete
        .clone()
        .json()
        .catch(() => null),
    }
  }

  const saveSessionAs = async (
    user,
    session,
    { expectedRevision = session.revision ?? 0, generation = session.generation ?? 'legacy' } = {}
  ) => {
    const body = {
      ...session,
      revision: undefined,
      generation: undefined,
    }
    return uploadBlobAs(
      user,
      {
        kind: 'chat',
        id: session.id,
        generation,
        expectedRevision,
      },
      new Blob([JSON.stringify(body)], { type: 'application/json' })
    )
  }

  const snapshotAs = async (user) => {
    const response = await api(user, '/api/chats')
    if (response.status !== 200) {
      throw new Error(`Unable to read history: ${response.status}`)
    }
    return response.json()
  }

  const loadSessionAs = async (user, id) => {
    const response = await api(user, `/api/chats/${encodeURIComponent(id)}`)
    if (response.status === 404) {
      return undefined
    }
    if (response.status !== 200) {
      throw new Error(`Unable to read session ${id}: ${response.status}`)
    }
    return (await response.json()).session
  }

  const loadAllSessionsAs = async (user) => {
    const snapshot = await snapshotAs(user)
    const sessions = await Promise.all(
      snapshot.sessions.map((summary) => loadSessionAs(user, summary.id))
    )
    return { ...snapshot, sessions }
  }

  const freshModules = async () => {
    const url = `${pathToFileURL(`${process.cwd()}/${OUTPUT}`).href}?fresh=${++freshSequence}`
    return import(url)
  }

  const intercept = (handler) => {
    interceptors.push(handler)
    return () => {
      const index = interceptors.indexOf(handler)
      if (index !== -1) {
        interceptors.splice(index, 1)
      }
    }
  }

  const dispose = async () => {
    if (disposed) {
      return
    }
    disposed = true
    modules.store.resetChatState()
    modules.backend.setBackendUserId(null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (globalThis.fetch === fakeFetch) {
      globalThis.fetch = originalFetch
    }
    db.close()
  }

  return {
    modules,
    db,
    files,
    env,
    sync,
    users,
    requests,
    addUser,
    api,
    intercept,
    createImport,
    uploadBlobAs,
    saveSessionAs,
    snapshotAs,
    loadSessionAs,
    loadAllSessionsAs,
    freshModules,
    setCurrentUser,
    get currentUser() {
      return currentUser
    },
    waitUntil,
    gate: createGate,
    toFile,
    dispose,
  }
}
