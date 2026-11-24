import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const PROJECT_ROOT = process.cwd()
const PROJECT_TEMPORARY_ROOT = join(PROJECT_ROOT, 'tmp')
const API_ORIGIN = 'https://chat.example.com'
const TEST_SECRET_HEADER = 'X-Worker-Cloud-Test-Secret'
const SESSION_COOKIE = 'deepseek_chat_session'

const TEST_ENTRY = `
  import worker, { HistorySync } from './server/index.ts'
  import { hashPassword, sha256 } from './server/security.ts'

  export { HistorySync }

  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })

  const readJson = async (request) => {
    try {
      return await request.json()
    } catch {
      throw new Error('测试请求不是有效 JSON')
    }
  }

  const requireTestSecret = (request, env) => {
    if (request.headers.get('${TEST_SECRET_HEADER}') !== env.WORKER_CLOUD_TEST_SECRET) {
      return json({ error: { message: '测试接口不存在' } }, 404)
    }
    return null
  }

  const createUser = async (env, body) => {
    const passwordHash =
      typeof body.password === 'string' ? await hashPassword(body.password) : null
    await env.DB.prepare(
      \`INSERT INTO users
         (id, username, password_hash, role, status, created_at, auth_version)
       VALUES (?, ?, ?, 'user', 'active', ?, 1)\`
    )
      .bind(body.id, body.username.toLowerCase(), passwordHash, Date.now())
      .run()
    await env.DB.prepare(
      \`INSERT OR IGNORE INTO cloud_history (user_id, generation, revision)
       VALUES (?, 'legacy', 1)\`
    )
      .bind(body.id)
      .run()
  }

  const createSession = async (env, body) => {
    const user = await env.DB.prepare(
      'SELECT id, auth_version FROM users WHERE id = ? AND status = \\'active\\''
    )
      .bind(body.userId)
      .first()
    if (!user) {
      throw new Error('测试账号不存在或已停用')
    }
    const now = Date.now()
    const tokenHash = await sha256(body.token)
    await env.DB.prepare(
      \`INSERT INTO auth_sessions
         (token_hash, user_id, expires_at, created_at, auth_version, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?)\`
    )
      .bind(
        tokenHash,
        user.id,
        now + 7 * 86_400_000,
        now,
        user.auth_version,
        now + 30 * 86_400_000
      )
      .run()
    return tokenHash
  }

  const isWordCharacter = (character) => {
    const code = character.charCodeAt(0)
    return (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === '_' ||
      character === '$'
    )
  }

  const isTriggerHeader = (prefix) => {
    const withoutComments = prefix
      .replace(/--[^\\n]*(?:\\n|$)/g, ' ')
      .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')
      .trimStart()
    return /^CREATE\\s+(?:(?:TEMP|TEMPORARY)\\s+)?TRIGGER\\b/i.test(withoutComments)
  }

  const hasSql = (statement) => {
    const withoutComments = statement
      .replace(/--[^\\n]*(?:\\n|$)/g, ' ')
      .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')
    return withoutComments.trim().length > 0
  }

  const splitSqlStatements = (sql) => {
    const statements = []
    let start = 0
    let quote = ''
    let lineComment = false
    let blockComment = false
    let wordStart = -1
    let triggerBody = false
    let triggerDepth = 0

    const inspectWord = (from, to) => {
      const word = sql.slice(from, to).toUpperCase()
      if (!triggerBody) {
        if (word === 'BEGIN' && isTriggerHeader(sql.slice(start, from))) {
          triggerBody = true
          triggerDepth = 1
        }
        return
      }
      if (word === 'BEGIN' || word === 'CASE') {
        triggerDepth += 1
      } else if (word === 'END') {
        triggerDepth -= 1
      }
    }

    for (let index = 0; index < sql.length; index += 1) {
      const character = sql[index]
      const next = sql[index + 1]

      if (wordStart !== -1 && !isWordCharacter(character)) {
        inspectWord(wordStart, index)
        wordStart = -1
      }
      if (lineComment) {
        if (character === '\\n') {
          lineComment = false
        }
        continue
      }
      if (blockComment) {
        if (character === '*' && next === '/') {
          blockComment = false
          index += 1
        }
        continue
      }
      if (quote) {
        if (character === quote) {
          if (next === quote) {
            index += 1
          } else {
            quote = ''
          }
        }
        continue
      }
      if (character === '-' && next === '-') {
        lineComment = true
        index += 1
        continue
      }
      if (character === '/' && next === '*') {
        blockComment = true
        index += 1
        continue
      }
      if (character === "'" || character === '"' || character === '\`' || character === '[') {
        quote = character === '[' ? ']' : character
        continue
      }
      if (isWordCharacter(character)) {
        if (wordStart === -1) {
          wordStart = index
        }
        continue
      }
      if (character === ';' && (!triggerBody || triggerDepth === 0)) {
        const statement = sql.slice(start, index + 1).trim()
        if (hasSql(statement)) {
          statements.push(statement)
        }
        start = index + 1
        triggerBody = false
        triggerDepth = 0
      }
    }
    const tail = sql.slice(start).trim()
    if (hasSql(tail)) {
      statements.push(tail)
    }
    return statements
  }

  const testFetch = async (request, env) => {
    const path = new URL(request.url).pathname
    if (!path.startsWith('/__worker_cloud_test/')) {
      return null
    }
    const rejected = requireTestSecret(request, env)
    if (rejected) {
      return rejected
    }

    if (path === '/__worker_cloud_test/migrate' && request.method === 'POST') {
      const body = await readJson(request)
      if (!Array.isArray(body.migrations)) {
        return json({ error: { message: 'migrations 必须是数组' } }, 400)
      }
      const applied = []
      const statementCounts = {}
      let currentMigration = null
      let currentStatements = []
      try {
        for (const migration of body.migrations) {
          if (
            !migration ||
            typeof migration.name !== 'string' ||
            typeof migration.sql !== 'string'
          ) {
            return json({ error: { message: '迁移内容无效' } }, 400)
          }
          currentMigration = migration.name
          currentStatements = splitSqlStatements(migration.sql)
          if (currentStatements.length === 0) {
            throw new Error('迁移没有可执行语句')
          }
          await env.DB.batch(currentStatements.map((statement) => env.DB.prepare(statement)))
          applied.push(migration.name)
          statementCounts[migration.name] = currentStatements.length
        }
      } catch (error) {
        return json(
          {
            applied,
            statementCounts,
            currentMigration,
            currentStatements,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
          500
        )
      }
      const tables = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all()
      return json({
        applied,
        statementCounts,
        tables: tables.results.map((row) => row.name),
      })
    }

    if (path === '/__worker_cloud_test/account' && request.method === 'POST') {
      const body = await readJson(request)
      await createUser(env, body)
      await createSession(env, { ...body, userId: body.id })
      return json({ ok: true }, 201)
    }

    if (path === '/__worker_cloud_test/session' && request.method === 'POST') {
      const body = await readJson(request)
      await createSession(env, body)
      return json({ ok: true }, 201)
    }

    if (path === '/__worker_cloud_test/exec' && request.method === 'POST') {
      const body = await readJson(request)
      if (typeof body.sql !== 'string') {
        return json({ error: { message: 'sql 必须是字符串' } }, 400)
      }
      const params = Array.isArray(body.params) ? body.params : []
      const statement = env.DB.prepare(body.sql).bind(...params)
      if (body.mode === 'all') {
        const result = await statement.all()
        return json({ results: result.results, meta: result.meta })
      }
      if (body.mode === 'first') {
        return json({ result: await statement.first() })
      }
      const result = await statement.run()
      return json({ meta: result.meta })
    }

    if (path === '/__worker_cloud_test/notify-user' && request.method === 'POST') {
      const body = await readJson(request)
      const stub = env.SYNC.get(env.SYNC.idFromName(body.userId))
      const response = await stub.fetch('https://sync.internal/notify', { method: 'POST' })
      return new Response(null, { status: response.status })
    }

    return json({ error: { message: '测试接口不存在' } }, 404)
  }

  export default {
    ...worker,
    async fetch(request, env, ctx) {
      return (await testFetch(request, env)) ?? worker.fetch(request, env, ctx)
    },
  }
`

let miniflareModulePromise
let buildPromise
let sequence = 0

const assertSafeTemporaryDirectory = (directory) => {
  const temporaryRoot = resolve(PROJECT_TEMPORARY_ROOT)
  const candidate = resolve(directory)
  if (candidate !== temporaryRoot && !candidate.startsWith(`${temporaryRoot}${sep}`)) {
    throw new Error(`拒绝清理临时目录之外的路径: ${candidate}`)
  }
}

const resolveWranglerRequire = () =>
  createRequire(pathToFileURL(join(PROJECT_ROOT, 'package.json')))

const resolveMiniflareEntry = () => {
  const wranglerPackage = resolveWranglerRequire().resolve('wrangler/package.json')
  return createRequire(pathToFileURL(wranglerPackage)).resolve('miniflare')
}

export const loadMiniflareModule = async () => {
  miniflareModulePromise ??= import(pathToFileURL(resolveMiniflareEntry()).href)
  return miniflareModulePromise
}

export const buildWorkerCloudBundle = async () => {
  buildPromise ??= (async () => {
    const outputDirectory = mkdtempSync(join(PROJECT_ROOT, 'tmp', 'worker-cloud-e2e-'))
    const outputFile = join(outputDirectory, 'worker.mjs')
    try {
      await build({
        stdin: {
          contents: TEST_ENTRY,
          resolveDir: PROJECT_ROOT,
          sourcefile: 'worker-cloud-test-entry.ts',
          loader: 'ts',
        },
        outfile: outputFile,
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        mainFields: ['browser', 'module', 'main'],
        conditions: ['workerd', 'worker', 'browser'],
        legalComments: 'none',
      })
      return { outputDirectory, outputFile }
    } catch (error) {
      assertSafeTemporaryDirectory(outputDirectory)
      rmSync(outputDirectory, { recursive: true, force: true })
      buildPromise = undefined
      throw error
    }
  })()
  return buildPromise
}

const migrationSnapshot = () =>
  readdirSync(join(PROJECT_ROOT, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(PROJECT_ROOT, 'migrations', name), 'utf8'),
    }))

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const createStaticAssetsService = (directory) => {
  const root = resolve(directory)
  const rootPrefix = `${root}${sep}`
  return async (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    const relative = pathname.replace(/^\/+/, '')
    let file = resolve(root, relative || 'index.html')
    if (file !== root && !file.startsWith(rootPrefix)) {
      return new Response('Not found', { status: 404 })
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      file = join(root, 'index.html')
    }
    if (!existsSync(file)) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(readFileSync(file), {
      headers: {
        'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      },
    })
  }
}

const createMiniflare = async ({
  outputFile,
  testSecret,
  vars,
  assetsPath,
  persistentPath,
}) => {
  const miniflareModule = await loadMiniflareModule()
  const workerOptions = {
    scriptPath: outputFile,
    modules: true,
    compatibilityDate: '2026-11-17',
    bindings: {
      ...vars,
      WORKER_CLOUD_TEST_SECRET: testSecret,
    },
    d1Databases: { DB: 'worker-cloud-e2e-db' },
    r2Buckets: { FILES: 'worker-cloud-e2e-files' },
    durableObjects: {
      SYNC: { className: 'HistorySync', useSQLite: true },
    },
    ...(assetsPath
      ? { serviceBindings: { ASSETS: createStaticAssetsService(assetsPath) } }
      : {}),
    ...(persistentPath ? { resourcePersistencePath: persistentPath } : {}),
  }
  const options = miniflareModule.convertV4MiniflareOptions
    ? miniflareModule.convertV4MiniflareOptions(workerOptions)
    : workerOptions
  const miniflare = new miniflareModule.Miniflare(options)
  const readyUrl = await miniflare.ready
  return {
    miniflare,
    miniflareOrigin: new URL(miniflare.publicUrl ?? readyUrl).origin,
  }
}

const readResponseJson = async (response) => {
  const text = await response.text()
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text } }
  }
}

const waitFor = async (predicate, message, timeout = 10_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) {
      return
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error(message)
}

const loadWebSocketClass = () => {
  const requireFromMiniflare = createRequire(pathToFileURL(resolveMiniflareEntry()))
  const moduleValue = requireFromMiniflare('ws')
  return moduleValue.WebSocket ?? moduleValue
}

export const createWorkerCloudHarness = async ({
  vars = {},
  assetsPath,
  persistentPath,
} = {}) => {
  const testSecret = `worker-cloud-test-${crypto.randomUUID()}`
  const envVars = {
    ADMIN_USERNAME: 'worker_cloud_admin',
    ADMIN_PASSWORD: 'worker-cloud-admin-password',
    API_KEY_ENCRYPTION_KEY: 'worker-cloud-test-encryption-key-with-sufficient-length',
    DEEPSEEK_API_KEY: 'sk-worker-cloud-test',
    ...vars,
  }
  const bundle = await buildWorkerCloudBundle()
  let miniflare = null
  let disposed = false
  const sockets = new Set()
  const runtime = await createMiniflare({
    outputFile: bundle.outputFile,
    testSecret,
    vars: envVars,
    assetsPath,
    persistentPath,
  })
  miniflare = runtime.miniflare
  const miniflareOrigin = runtime.miniflareOrigin

  const dispatch = (path, init) => miniflare.dispatchFetch(`${API_ORIGIN}${path}`, init)

  const helperRequest = async (path, body, method = 'POST') => {
    const response = await dispatch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        [TEST_SECRET_HEADER]: testSecret,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const value = await readResponseJson(response)
    if (!response.ok) {
      throw new Error(
        `Worker 测试准备接口 ${path} 失败 (${response.status}): ${JSON.stringify(value)}`
      )
    }
    return value
  }

  const initialize = async () => {
    const migrations = migrationSnapshot()
    const migrated = await helperRequest('/__worker_cloud_test/migrate', { migrations })
    return { ...migrated, migrations }
  }

  const addAccount = async (username, { password, id } = {}) => {
    sequence += 1
    const account = {
      id: id ?? `worker-cloud-user-${process.pid}-${sequence}-${crypto.randomUUID()}`,
      username: username.toLowerCase(),
      token: crypto.randomUUID() + crypto.randomUUID(),
      password,
    }
    account.tokenHash = null
    account.cookie = `${SESSION_COOKIE}=${account.token}`
    await helperRequest('/__worker_cloud_test/account', {
      id: account.id,
      username: account.username,
      token: account.token,
      password,
    })
    return account
  }

  const addSession = async (account) => {
    const device = {
      ...account,
      token: crypto.randomUUID() + crypto.randomUUID(),
    }
    device.cookie = `${SESSION_COOKIE}=${device.token}`
    await helperRequest('/__worker_cloud_test/session', {
      userId: account.id,
      token: device.token,
    })
    return device
  }

  const api = async (
    account,
    path,
    { method = 'GET', body, headers = {}, csrf = true } = {}
  ) => {
    if (!path.startsWith('/api/')) {
      throw new Error(`Worker API 路径必须以 /api/ 开头: ${path}`)
    }
    const requestHeaders = new Headers(headers)
    requestHeaders.set('Cookie', account.cookie)
    requestHeaders.set('Origin', API_ORIGIN)
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
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
      !(body instanceof ReadableStream)
    ) {
      requestHeaders.set('Content-Type', 'application/json')
      requestBody = JSON.stringify(body)
    }
    return dispatch(path, { method, headers: requestHeaders, body: requestBody })
  }

  const expectApi = async (account, path, options) => {
    const response = await api(account, path, options)
    const value = await readResponseJson(response)
    if (!response.ok) {
      throw new Error(
        `Worker API ${options?.method ?? 'GET'} ${path} 失败 (${response.status}): ${JSON.stringify(value)}`
      )
    }
    return { response, value }
  }

  const query = async (sql, params = []) =>
    (await helperRequest('/__worker_cloud_test/exec', { sql, params, mode: 'all' })).results

  const execute = async (sql, params = []) =>
    (await helperRequest('/__worker_cloud_test/exec', { sql, params })).meta

  const openSync = async (account) => {
    const path = `/api/sync?user=${encodeURIComponent(account.id)}`
    const WebSocketClass = loadWebSocketClass()
    const socket = new WebSocketClass(
      new URL(path, miniflareOrigin).toString().replace(/^http/, 'ws'),
      {
        headers: {
          Cookie: account.cookie,
          Origin: API_ORIGIN,
        },
      }
    )

    const messages = []
    const waiters = []
    let readIndex = 0
    let closeInfo = null
    let protocolError = null
    const settleWaiters = () => {
      for (let index = waiters.length - 1; index >= 0; index--) {
        const waiter = waiters[index]
        const match = messages
          .slice(readIndex)
          .find((message) => message.type === waiter.type)
        if (match) {
          readIndex = messages.indexOf(match) + 1
          clearTimeout(waiter.timer)
          waiters.splice(index, 1)
          waiter.resolve(match)
        }
      }
    }
    const handleMessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      messages.push(JSON.parse(text))
      settleWaiters()
    }
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', (event) => {
      closeInfo = {
        code: event.code,
        reason:
          typeof event.reason === 'string'
            ? event.reason
            : new TextDecoder().decode(event.reason),
      }
      const error = new Error(`同步连接已关闭: ${event.code} ${event.reason ?? ''}`)
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
    })
    socket.addEventListener('error', (event) => {
      protocolError = new Error(`同步连接错误: ${event.message ?? 'unknown'}`)
      const error = protocolError
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
    })
    const record = {
      socket,
      messages,
      waitForType(type, timeout = 10_000) {
        if (protocolError) {
          return Promise.reject(protocolError)
        }
        if (closeInfo) {
          return Promise.reject(
            new Error(`同步连接已关闭: ${closeInfo.code} ${closeInfo.reason ?? ''}`)
          )
        }
        const existing = messages.slice(readIndex).find((message) => message.type === type)
        if (existing) {
          readIndex = messages.indexOf(existing) + 1
          return Promise.resolve(existing)
        }
        return new Promise((resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.timer === timer)
            if (index !== -1) {
              waiters.splice(index, 1)
            }
            rejectPromise(new Error(`等待同步消息 ${type} 超时`))
          }, timeout)
          waiters.push({ type, resolve: resolvePromise, reject: rejectPromise, timer })
        })
      },
      hasUnread(type) {
        return messages.slice(readIndex).some((message) => message.type === type)
      },
      async close() {
        if (closeInfo) {
          return
        }
        socket.close()
      },
      get closeInfo() {
        return closeInfo
      },
    }
    sockets.add(record)
    await record.waitForType('ready')
    return record
  }

  const notifyUser = async (userId) => {
    await helperRequest('/__worker_cloud_test/notify-user', { userId })
  }

  const revokeAccount = async (account) =>
    execute('DELETE FROM auth_sessions WHERE user_id = ?', [account.id])

  const uploadBytes = async (account, metadata, bytes) => {
    const started = await expectApi(account, '/api/storage/uploads', {
      method: 'POST',
      body: metadata,
    })
    const uploadId = started.value.id
    const uploadPath = `/api/storage/uploads/${encodeURIComponent(uploadId)}`
    const uploading = await expectApi(account, uploadPath)
    const partSize = 8 * 1024 * 1024
    const partCount = Math.max(1, Math.ceil(bytes.byteLength / partSize))
    const partResponses = []
    for (let part = 1; part <= partCount; part++) {
      const partResponse = await expectApi(account, `${uploadPath}/parts/${part}`, {
        method: 'PUT',
        body: bytes.slice((part - 1) * partSize, part * partSize),
      })
      partResponses.push(partResponse.value)
    }
    const afterParts = await expectApi(account, uploadPath)
    const completed = await expectApi(account, `${uploadPath}/complete`, {
      method: 'POST',
      body: { parts: partCount },
    })
    const status = await expectApi(account, uploadPath)
    return {
      uploadId,
      uploadPath,
      partCount,
      partResponses,
      started: started.value,
      uploading: uploading.value,
      afterParts: afterParts.value,
      completed: completed.value,
      status: status.value,
    }
  }

  const uploadChat = async (account, { id, generation, expectedRevision, importId, session }) =>
    uploadBytes(
      account,
      {
        kind: 'chat',
        id,
        generation,
        expectedRevision,
        importId,
      },
      new TextEncoder().encode(JSON.stringify(session))
    )

  const uploadFile = async (
    account,
    { id, generation, expectedRevision, importId, mimeType, bytes }
  ) =>
    uploadBytes(
      account,
      {
        kind: 'file',
        id,
        generation,
        expectedRevision,
        importId,
        mimeType,
      },
      bytes
    )

  const dispose = async () => {
    if (disposed) {
      return
    }
    disposed = true
    for (const socket of sockets) {
      await socket.close().catch(() => {})
    }
    if (miniflare) {
      await miniflare.dispose()
    }
  }

  return {
    api,
    expectApi,
    initialize,
    addAccount,
    addSession,
    query,
    execute,
    openSync,
    notifyUser,
    revokeAccount,
    uploadBytes,
    uploadChat,
    uploadFile,
    waitFor,
    dispose,
    get testSecret() {
      return testSecret
    },
    get bundle() {
      return bundle
    },
    get miniflareOrigin() {
      return miniflareOrigin
    },
    get origin() {
      return miniflareOrigin
    },
  }
}

export const removeWorkerCloudBundle = async () => {
  if (!buildPromise) {
    return
  }
  const bundle = await buildPromise
  assertSafeTemporaryDirectory(bundle.outputDirectory)
  rmSync(bundle.outputDirectory, { recursive: true, force: true })
  buildPromise = undefined
}
