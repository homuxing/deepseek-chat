/* eslint-disable no-console -- 测试需要拦截和验证同步模块的错误日志。 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('test-results', { recursive: true })
await build({
  stdin: {
    contents: `
      export { bindHistorySync } from './src/services/chat/sync.ts'
      export { loadHistorySnapshot } from './src/services/chat/db.ts'
      export {
        captureBackendIdentity,
        getBackendUserId,
        setBackendUserId,
      } from './src/services/backend.ts'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'tests-sync-entry.ts',
    loader: 'ts',
  },
  outfile: 'test-results/sync.mjs',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
})

const sync = await import('../test-results/sync.mjs')
const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  WebSocket: globalThis.WebSocket,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  fetch: globalThis.fetch,
  consoleError: console.error,
}
const activeDisposers = []

class FakeWindow extends EventTarget {
  constructor(href = 'https://chat.example.com/app') {
    super()
    this.location = { href }
    this.navigator = { onLine: true }
  }
}

class FakeDocument extends EventTarget {
  visibilityState = 'visible'
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []

  constructor(url) {
    super()
    this.url = String(url)
    this.readyState = FakeWebSocket.CONNECTING
    this.closeCalls = []
    FakeWebSocket.instances.push(this)
  }

  close(code = 1000, reason = '') {
    this.closeCalls.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
  }

  emitMessage(value) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  emitError() {
    this.dispatchEvent(new Event('error'))
  }

  emitClose(code, reason = '') {
    this.readyState = FakeWebSocket.CLOSED
    const event = new Event('close')
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
      wasClean: { value: code === 1000 || code === 1008 },
    })
    this.dispatchEvent(event)
  }
}

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const createTimers = () => {
  let nextId = 1
  const pending = new Map()
  const delays = []
  globalThis.setTimeout = (callback, delay) => {
    const id = nextId++
    pending.set(id, callback)
    delays.push(delay)
    return id
  }
  globalThis.clearTimeout = (id) => {
    pending.delete(id)
  }
  return {
    delays,
    get size() {
      return pending.size
    },
    runNext() {
      const entry = pending.entries().next().value
      assert.ok(entry, 'expected a pending reconnect timer')
      pending.delete(entry[0])
      entry[1]()
    },
  }
}

const installGlobals = ({ user = 'user-a', href } = {}) => {
  const page = new FakeWindow(href)
  const targetDocument = new FakeDocument()
  FakeWebSocket.instances = []
  globalThis.window = page
  globalThis.document = targetDocument
  globalThis.WebSocket = FakeWebSocket
  sync.setBackendUserId(user)
  return { page, document: targetDocument }
}

const startSync = (onChanged) => {
  const dispose = sync.bindHistorySync(onChanged)
  activeDisposers.push(dispose)
  return dispose
}

const flush = async () => {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve()
  }
}

afterEach(() => {
  while (activeDisposers.length > 0) {
    activeDisposers.pop()()
  }
  sync.setBackendUserId(null)
  globalThis.window = originalGlobals.window
  globalThis.document = originalGlobals.document
  globalThis.WebSocket = originalGlobals.WebSocket
  globalThis.setTimeout = originalGlobals.setTimeout
  globalThis.clearTimeout = originalGlobals.clearTimeout
  globalThis.fetch = originalGlobals.fetch
  console.error = originalGlobals.consoleError
  FakeWebSocket.instances = []
})

test('未知同步消息不改变本地导入进度，也不触发会话目录读取', async () => {
  const { page } = installGlobals({ user: 'alice' })
  const calls = []
  const progress = []
  const dispose = startSync(async () => {
    calls.push('read')
  })
  page.addEventListener('history:import-progress', (event) => progress.push(event.detail))
  const message = {
    type: 'import-progress',
    importId: 'task-a',
    phase: 'processing',
    sessions: 5,
    files: 2,
    totalSessions: 10,
    totalFiles: 3,
  }
  const socket = FakeWebSocket.instances[0]
  socket.emitMessage(message)
  await flush()
  assert.deepEqual(progress, [])
  assert.deepEqual(calls, [])
  dispose()
  socket.emitMessage(message)
  assert.equal(progress.length, 0)
})

test('连接同一账号并串行合并 initial ready 与 changed 通知', async () => {
  installGlobals({ user: 'alice' })
  createTimers()
  const first = deferred()
  const second = deferred()
  const calls = []
  const onChanged = () => {
    const task = deferred()
    calls.push(task)
    if (calls.length === 1) {
      return first.promise
    }
    if (calls.length === 2) {
      return second.promise
    }
    return task.promise
  }
  const dispose = startSync(onChanged)

  assert.equal(FakeWebSocket.instances.length, 1)
  assert.equal(FakeWebSocket.instances[0].url, 'wss://chat.example.com/api/sync?user=alice')
  const socket = FakeWebSocket.instances[0]
  socket.emitMessage({ type: 'ready' })
  socket.emitMessage({ type: 'changed' })
  socket.emitMessage({ type: 'changed' })
  socket.emitMessage({ type: 'ready' })
  await flush()
  assert.equal(calls.length, 1)

  first.resolve()
  await flush()
  assert.equal(calls.length, 2)

  second.resolve()
  await flush()
  assert.equal(calls.length, 2)
  dispose()
})

test('visible、focus 和 online 触发读取，hidden 和 offline 清理连接与计时器', async () => {
  const environment = installGlobals({ user: 'alice' })
  const timers = createTimers()
  const calls = []
  const dispose = startSync(async () => {
    calls.push(sync.getBackendUserId())
  })
  const first = FakeWebSocket.instances[0]
  first.readyState = FakeWebSocket.OPEN
  first.emitMessage({ type: 'ready' })
  await flush()
  assert.deepEqual(calls, ['alice'])

  environment.page.dispatchEvent(new Event('focus'))
  await flush()
  assert.deepEqual(calls, ['alice', 'alice'])

  environment.document.visibilityState = 'hidden'
  environment.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(first.closeCalls.length, 1)
  first.emitMessage({ type: 'changed' })
  await flush()
  assert.equal(calls.length, 2)

  environment.document.visibilityState = 'visible'
  environment.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(FakeWebSocket.instances.length, 2)
  const second = FakeWebSocket.instances[1]
  second.readyState = FakeWebSocket.OPEN
  second.emitMessage({ type: 'ready' })
  await flush()
  assert.equal(calls.length, 3)

  environment.page.navigator.onLine = false
  environment.page.dispatchEvent(new Event('offline'))
  assert.equal(second.closeCalls.length, 1)
  assert.equal(timers.size, 0)
  second.emitClose(1006, 'offline')
  assert.equal(timers.size, 0)

  environment.page.navigator.onLine = true
  environment.page.dispatchEvent(new Event('online'))
  assert.equal(FakeWebSocket.instances.length, 3)
  const third = FakeWebSocket.instances[2]
  third.readyState = FakeWebSocket.OPEN
  third.emitMessage({ type: 'ready' })
  await flush()
  assert.equal(calls.length, 4)
  dispose()
})

test('切换账号会关闭旧连接，旧 socket 事件不能触发当前账号读取', async () => {
  installGlobals({ user: 'alice' })
  createTimers()
  const running = deferred()
  const calls = []
  const dispose = startSync(async () => {
    const call = deferred()
    calls.push({ user: sync.getBackendUserId(), call })
    if (calls.length === 1) {
      return running.promise
    }
    return call.promise
  })
  const oldSocket = FakeWebSocket.instances[0]
  oldSocket.readyState = FakeWebSocket.OPEN
  oldSocket.emitMessage({ type: 'ready' })
  await flush()
  assert.deepEqual(
    calls.map((call) => call.user),
    ['alice']
  )

  sync.setBackendUserId('bob')
  assert.equal(oldSocket.closeCalls.length, 1)
  assert.equal(FakeWebSocket.instances.length, 2)
  const nextSocket = FakeWebSocket.instances[1]
  assert.equal(nextSocket.url, 'wss://chat.example.com/api/sync?user=bob')

  oldSocket.emitMessage({ type: 'changed' })
  oldSocket.emitClose(1006, 'old socket')
  await flush()
  assert.equal(calls.length, 1)

  nextSocket.readyState = FakeWebSocket.OPEN
  nextSocket.emitMessage({ type: 'ready' })
  await flush()
  // 旧回调尚未结束时，新账号通知只排队，不会并发覆盖。
  assert.equal(calls.length, 1)
  running.resolve()
  await flush()
  assert.deepEqual(
    calls.map((call) => call.user),
    ['alice', 'bob']
  )
  calls[1].call.resolve()
  await flush()
  dispose()
})

test('1008 触发目录鉴权读取并派发 auth:expired，同一账号停止重连', async () => {
  const environment = installGlobals({ user: 'alice' })
  const timers = createTimers()
  const errors = []
  console.error = (...args) => errors.push(args)
  const requests = []
  let authExpired = 0
  environment.page.addEventListener('auth:expired', () => {
    authExpired += 1
  })
  let authenticated = true
  globalThis.fetch = async (path, init) => {
    requests.push({ path, user: init.headers.get('X-Chat-User-ID') })
    return authenticated
      ? Response.json({ sessions: [], generation: 'generation-a', revision: 0 })
      : Response.json(
          { error: { message: '登录已失效' } },
          { status: 401, headers: { 'X-Auth-Expired': '1' } }
        )
  }
  const dispose = startSync(async () => {
    await sync.loadHistorySnapshot()
  })
  const invalid = FakeWebSocket.instances[0]
  invalid.readyState = FakeWebSocket.OPEN
  invalid.emitMessage({ type: 'ready' })
  await flush()
  assert.deepEqual(requests, [{ path: '/api/chats', user: 'alice' }])

  authenticated = false
  invalid.emitClose(1008, '登录状态已变更')
  await flush()
  // 等待 Response 解析和回调错误报告，不依赖真实计时器。
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(requests, [
    { path: '/api/chats', user: 'alice' },
    { path: '/api/chats', user: 'alice' },
  ])
  assert.equal(authExpired, 1)
  assert.equal(errors[0][0], '多设备同步认证已失效')
  assert.equal(errors[1][0], '多设备同步回调执行失败')
  assert.equal(errors[1][1].status, 401)
  assert.equal(errors[1][1].message, '登录已失效')
  assert.equal(timers.size, 0)
  invalid.emitClose(1008, '重复关闭')
  invalid.emitMessage({ type: 'changed' })
  environment.page.dispatchEvent(new Event('focus'))
  environment.page.dispatchEvent(new Event('online'))
  environment.document.visibilityState = 'hidden'
  environment.document.dispatchEvent(new Event('visibilitychange'))
  environment.document.visibilityState = 'visible'
  environment.document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.equal(requests.length, 2)
  assert.equal(authExpired, 1)
  assert.equal(timers.size, 0)
  assert.equal(FakeWebSocket.instances.length, 1)
  dispose()
})

test('读取进行中收到 1008 会合并为结束后的一次读取，旧连接不再通知', async () => {
  installGlobals({ user: 'alice' })
  const timers = createTimers()
  const first = deferred()
  const calls = []
  console.error = () => {}
  const dispose = startSync(async () => {
    calls.push(sync.getBackendUserId())
    if (calls.length === 1) {
      await first.promise
    }
  })
  const socket = FakeWebSocket.instances[0]
  socket.readyState = FakeWebSocket.OPEN
  socket.emitMessage({ type: 'ready' })
  socket.emitMessage({ type: 'changed' })
  socket.emitClose(1008, '登录已失效')
  socket.emitClose(1008, '重复关闭')
  socket.emitMessage({ type: 'changed' })
  await flush()
  assert.deepEqual(calls, ['alice'])
  assert.equal(timers.size, 0)

  first.resolve()
  await flush()
  assert.deepEqual(calls, ['alice', 'alice'])
  assert.equal(timers.size, 0)
  dispose()
})

test('首次 ready 前收到 1008 也读取一次，回调失败不会重连', async () => {
  installGlobals({ user: 'alice' })
  const timers = createTimers()
  const errors = []
  console.error = (...args) => errors.push(args)
  let calls = 0
  const dispose = startSync(async () => {
    calls += 1
    throw new Error('无法确认登录状态')
  })
  const socket = FakeWebSocket.instances[0]
  socket.emitClose(1008, '登录已失效')
  await flush()
  socket.emitMessage({ type: 'ready' })
  socket.emitClose(1008, '重复关闭')
  await flush()
  assert.equal(calls, 1)
  assert.equal(errors[1][0], '多设备同步回调执行失败')
  assert.equal(errors[1][1].message, '无法确认登录状态')
  assert.equal(timers.size, 0)
  assert.equal(FakeWebSocket.instances.length, 1)
  dispose()
})

test('1008 待处理读取在切号后取消，新账号 ready 正常读取且旧事件无效', async () => {
  installGlobals({ user: 'alice' })
  const timers = createTimers()
  const first = deferred()
  const calls = []
  console.error = () => {}
  const dispose = startSync(async () => {
    calls.push(sync.getBackendUserId())
    if (calls.length === 1) {
      await first.promise
    }
  })
  const oldSocket = FakeWebSocket.instances[0]
  oldSocket.emitMessage({ type: 'ready' })
  oldSocket.emitClose(1008, '登录已失效')
  sync.setBackendUserId('bob')
  assert.equal(FakeWebSocket.instances.length, 2)
  const currentSocket = FakeWebSocket.instances[1]
  currentSocket.emitMessage({ type: 'ready' })
  oldSocket.emitClose(1008, '旧账号关闭')
  oldSocket.emitMessage({ type: 'changed' })
  await flush()
  assert.deepEqual(calls, ['alice'])

  first.resolve()
  await flush()
  assert.deepEqual(calls, ['alice', 'bob'])
  assert.equal(timers.size, 0)
  assert.equal(FakeWebSocket.instances.length, 2)
  dispose()
})

test('1008 目录读取的旧账号 401 在切号后返回，不触发新账号 auth:expired', async () => {
  const environment = installGlobals({ user: 'alice' })
  const timers = createTimers()
  const oldResponse = deferred()
  const requests = []
  const completed = []
  let authExpired = 0
  console.error = () => {}
  environment.page.addEventListener('auth:expired', () => {
    authExpired += 1
  })
  globalThis.fetch = async (path, init) => {
    const user = init.headers.get('X-Chat-User-ID')
    requests.push({ path, user })
    if (user === 'alice') {
      return oldResponse.promise
    }
    return Response.json({ sessions: [], generation: 'generation-b', revision: 0 })
  }
  const dispose = startSync(async () => {
    const identity = sync.captureBackendIdentity()
    await sync.loadHistorySnapshot(identity)
    completed.push(identity.userId)
  })
  const oldSocket = FakeWebSocket.instances[0]
  oldSocket.emitClose(1008, '旧账号登录已失效')
  assert.deepEqual(requests, [{ path: '/api/chats', user: 'alice' }])
  sync.setBackendUserId('bob')
  FakeWebSocket.instances[1].emitMessage({ type: 'ready' })
  oldSocket.emitClose(1008, '旧连接关闭')
  oldResponse.resolve(
    Response.json(
      { error: { message: '登录已失效' } },
      { status: 401, headers: { 'X-Auth-Expired': '1' } }
    )
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(requests, [
    { path: '/api/chats', user: 'alice' },
    { path: '/api/chats', user: 'bob' },
  ])
  assert.deepEqual(completed, ['bob'])
  assert.equal(authExpired, 0)
  assert.equal(sync.getBackendUserId(), 'bob')
  assert.equal(timers.size, 0)
  dispose()
})

test('dispose 取消 1008 排队读取并清理恢复事件', async () => {
  const environment = installGlobals({ user: 'alice' })
  const timers = createTimers()
  const first = deferred()
  let calls = 0
  console.error = () => {}
  const dispose = startSync(async () => {
    calls += 1
    await first.promise
  })
  const socket = FakeWebSocket.instances[0]
  socket.emitMessage({ type: 'ready' })
  socket.emitClose(1008, '登录已失效')
  dispose()
  first.resolve()
  await flush()
  socket.emitClose(1008, '已清理连接')
  socket.emitMessage({ type: 'changed' })
  sync.setBackendUserId('bob')
  environment.page.dispatchEvent(new Event('focus'))
  environment.page.dispatchEvent(new Event('online'))
  environment.document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.equal(calls, 1)
  assert.equal(timers.size, 0)
  assert.equal(FakeWebSocket.instances.length, 1)
})

test('1006 按指数退避重连且上限为 30 秒，重连 ready 只读取一次', async () => {
  installGlobals({ user: 'alice' })
  const timers = createTimers()
  const calls = []
  const restarted = startSync(async () => {
    calls.push('read')
  })
  assert.equal(FakeWebSocket.instances.length, 1)
  FakeWebSocket.instances[0].emitClose(1006, 'network')
  for (let index = 0; index < 6; index++) {
    timers.runNext()
    const socket = FakeWebSocket.instances.at(-1)
    assert.ok(socket)
    socket.emitClose(1006, 'network')
  }
  assert.deepEqual(timers.delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000])
  timers.runNext()
  const reconnected = FakeWebSocket.instances.at(-1)
  reconnected.readyState = FakeWebSocket.OPEN
  reconnected.emitMessage({ type: 'ready' })
  reconnected.emitMessage({ type: 'ready' })
  await flush()
  assert.deepEqual(calls, ['read'])
  restarted()
})

test('1011 关闭后自动重连，ready 读取补足断开期间的云端变更', async () => {
  installGlobals({ user: 'alice' })
  const timers = createTimers()
  const errors = []
  console.error = (...args) => errors.push(args)
  const calls = []
  const dispose = startSync(async () => {
    calls.push(sync.getBackendUserId())
  })
  const socket = FakeWebSocket.instances[0]
  socket.emitMessage({ type: 'ready' })
  await flush()
  socket.emitClose(1011, '推送发送失败')
  assert.deepEqual(timers.delays, [1000])
  assert.equal(errors[0][0], '多设备同步连接已关闭（1011）')
  timers.runNext()
  const reconnected = FakeWebSocket.instances[1]
  reconnected.emitMessage({ type: 'ready' })
  reconnected.emitMessage({ type: 'ready' })
  socket.emitMessage({ type: 'changed' })
  await flush()
  assert.deepEqual(calls, ['alice', 'alice'])
  assert.equal(timers.size, 0)
  dispose()
})

test('error 与回调失败使用具体上下文输出，dispose 清理监听器且不再重连', async () => {
  installGlobals({ user: 'alice' })
  const timers = createTimers()
  const errors = []
  console.error = (...args) => {
    errors.push(args)
  }
  const dispose = startSync(async () => {
    throw new Error('history failed')
  })
  const socket = FakeWebSocket.instances[0]
  socket.readyState = FakeWebSocket.OPEN
  socket.emitError()
  socket.emitMessage({ type: 'ready' })
  await flush()
  assert.equal(errors[0][0], '多设备同步连接发生错误')
  assert.equal(errors[1][0], '多设备同步回调执行失败')
  assert.equal(errors[1][1].message, 'history failed')

  dispose()
  assert.equal(socket.closeCalls.length, 1)
  socket.emitClose(1006, 'disposed')
  assert.equal(timers.size, 0)
  assert.equal(FakeWebSocket.instances.length, 1)
})

test('页面隐藏或未登录时保持断开，恢复可见且登录后建立唯一连接', () => {
  const environment = installGlobals({
    user: null,
    href: 'http://localhost:5173/app',
  })
  createTimers()
  environment.document.visibilityState = 'hidden'
  const dispose = startSync(async () => {})
  assert.equal(FakeWebSocket.instances.length, 0)

  sync.setBackendUserId('alice')
  assert.equal(FakeWebSocket.instances.length, 0)
  environment.document.visibilityState = 'visible'
  environment.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(FakeWebSocket.instances.length, 1)
  assert.equal(FakeWebSocket.instances[0].url, 'ws://localhost:5173/api/sync?user=alice')

  environment.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(FakeWebSocket.instances.length, 1)
  dispose()
})
