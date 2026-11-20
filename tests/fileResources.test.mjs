import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('test-results', { recursive: true })
await build({
  stdin: {
    contents: "export * from './src/services/chat/fileResources.ts'",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: 'test-results/fileResources.mjs',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
})
const resources = await import('../test-results/fileResources.mjs')
const originalFetch = globalThis.fetch
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
const revoked = []
let sequence = 0
URL.createObjectURL = () => `blob:preview-${++sequence}`
URL.revokeObjectURL = (url) => revoked.push(url)
const flush = () => new Promise((resolve) => setImmediate(resolve))
afterEach(() => {
  resources.clearFileResources()
  revoked.length = 0
})
after(() => {
  globalThis.fetch = originalFetch
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
})

test('待保存原件立即可预览，保存完成前不读取远端，解除持有后随最后一个使用者释放', () => {
  globalThis.fetch = () => assert.fail('保存完成前不应读取原件')
  const file = { id: 'pending', blob: new Blob(['image'], { type: 'image/png' }) }
  resources.retainPendingFileResources([file])
  const thumbnail = resources.subscribeFileResource(file.id, () => {})
  const preview = resources.subscribeFileResource(file.id, () => {})
  const state = resources.getFileResource(file.id)
  assert.equal(state.status, 'ready')
  thumbnail()
  preview()
  assert.equal(resources.getFileResource(file.id), state)
  const remounted = resources.subscribeFileResource(file.id, () => {})
  resources.releasePendingFileResources([file])
  assert.equal(resources.getFileResource(file.id), state)
  assert.deepEqual(revoked, [])
  remounted()
  assert.deepEqual(revoked, [state.url])
  assert.equal(resources.getFileResource(file.id).status, 'loading')
})

test('缩略图与大图合并并发读取，并在最后一次取消订阅时撤销地址', async () => {
  let reads = 0
  globalThis.fetch = async () => {
    reads++
    return new Response('image', { headers: { 'Content-Type': 'image/png' } })
  }
  const thumbnail = resources.subscribeFileResource('shared', () => {})
  const preview = resources.subscribeFileResource('shared', () => {})
  await flush()
  assert.equal(reads, 1)
  const state = resources.getFileResource('shared')
  assert.equal(state.status, 'ready')
  thumbnail()
  assert.deepEqual(revoked, [])
  preview()
  assert.deepEqual(revoked, [state.url])
})

test('发送原件接管正在读取的同一附件，迟到的 404 无法覆盖缩略图', async () => {
  let resolveRead
  let signal
  globalThis.fetch = (_, init) => {
    signal = init.signal
    return new Promise((resolve) => {
      resolveRead = resolve
    })
  }
  const unsubscribe = resources.subscribeFileResource('race', () => {})
  const file = { id: 'race', blob: new Blob(['original']) }
  resources.retainPendingFileResources([file])
  const state = resources.getFileResource(file.id)
  assert.equal(signal.aborted, true)
  resolveRead(new Response(null, { status: 404 }))
  await flush()
  assert.equal(resources.getFileResource(file.id), state)
  unsubscribe()
  resources.releasePendingFileResources([file])
})

test('区分原件缺失和读取失败，重新进入后正常读取可恢复', async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 })
  let unsubscribe = resources.subscribeFileResource('unavailable', () => {})
  await flush()
  assert.equal(resources.getFileResource('unavailable').status, 'missing')
  unsubscribe()
  globalThis.fetch = async () => new Response('读取错误', { status: 500 })
  unsubscribe = resources.subscribeFileResource('unavailable', () => {})
  await flush()
  const state = resources.getFileResource('unavailable')
  assert.equal(state.status, 'error')
  assert.match(state.error.message, /读取错误/)
  unsubscribe()
  globalThis.fetch = async () => new Response('image')
  unsubscribe = resources.subscribeFileResource('unavailable', () => {})
  await flush()
  assert.equal(resources.getFileResource('unavailable').status, 'ready')
  unsubscribe()
})

test('账号或历史切换后取消旧读取，迟到结果不能覆盖新资源', async () => {
  let resolveRead
  let signal
  globalThis.fetch = (_, init) => {
    signal = init.signal
    return new Promise((resolve) => {
      resolveRead = resolve
    })
  }
  const oldSubscription = resources.subscribeFileResource('same-id', () => {})
  resources.clearFileResources()
  assert.equal(signal.aborted, true)
  const file = { id: 'same-id', blob: new Blob(['new account image']) }
  resources.retainPendingFileResources([file])
  const newSubscription = resources.subscribeFileResource(file.id, () => {})
  const state = resources.getFileResource(file.id)
  oldSubscription()
  resolveRead(new Response('old account image'))
  await flush()
  assert.equal(resources.getFileResource(file.id), state)
  newSubscription()
  resources.releasePendingFileResources([file])
  assert.deepEqual(revoked, [state.url])
})
