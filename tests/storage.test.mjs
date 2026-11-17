import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('test-results', { recursive: true })
await build({
  stdin: {
    contents:
      "export * from './src/services/chat/db.ts'; export * from './src/services/backend.ts'",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: 'test-results/storage.mjs',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
})
const storage = await import('../test-results/storage.mjs')
const originalFetch = globalThis.fetch
after(() => {
  globalThis.fetch = originalFetch
})
const snapshot = { id: 'chat-1', title: 'initial', createdAt: 1, updatedAt: 2, messages: [] }

test('queued saves preserve snapshots and renames cannot be overwritten by older uploads', async () => {
  const requests = []
  let releaseUpload
  const uploadReady = new Promise((resolve) => {
    releaseUpload = resolve
  })
  globalThis.fetch = async (path, init) => {
    requests.push({ path, ...init })
    if (path.startsWith('/api/files/')) {
      await uploadReady
    }
    return new Response(null, { status: 204 })
  }
  const current = structuredClone(snapshot)
  const saving = storage.saveSession(current, [{ id: 'file-1', blob: new Blob(['original']) }])
  current.title = 'changed in memory'
  const rename = storage.renameSession('chat-1', 'renamed later')
  releaseUpload()
  await Promise.all([saving, rename])
  assert.deepEqual(
    requests.map((req) => req.method),
    ['POST', 'PUT', 'PATCH']
  )
  assert.equal(JSON.parse(requests[1].body).session.title, 'initial')
  assert.equal(JSON.parse(requests[2].body).title, 'renamed later')
  assert.ok(
    requests.every(
      (req) =>
        req.credentials === 'same-origin' &&
        req.headers.get('X-Requested-With') === 'XMLHttpRequest'
    )
  )
})

test('import originals use fresh IDs, preserve shared references, and retain staging after failure', async () => {
  await storage.clearStaging()
  const current = {
    ...snapshot,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'picture',
        createdAt: 2,
        files: [
          {
            id: 'existing-file-id',
            serverId: 'old-upstream-id',
            name: 'picture.png',
            size: 7,
            isImage: true,
            mimeType: 'image/png',
          },
        ],
      },
    ],
  }
  await storage.addStagingSession(current)
  await storage.saveStagingFiles([
    { id: 'existing-file-id', blob: new Blob(['picture'], { type: 'image/png' }) },
  ])
  const requests = []
  let fail = true
  globalThis.fetch = async (path, init) => {
    requests.push({ path, ...init })
    if (path === '/api/chats/import') {
      if (fail) {
        return Response.json({ error: { message: 'database failed' } }, { status: 500 })
      }
      return Response.json({ sessions: [snapshot] })
    }
    return new Response(null, { status: 204 })
  }
  await assert.rejects(storage.commitStaging(), /database failed/)
  assert.ok(!requests[0].path.includes('existing-file-id'))
  const imported = JSON.parse(requests[1].body).sessions[0]
  assert.equal(requests[0].path, `/api/files/${imported.messages[0].files[0].id}`)
  assert.equal(imported.messages[0].files[0].serverId, null)
  assert.equal(current.messages[0].files[0].id, 'existing-file-id')
  fail = false
  const summaries = await storage.commitStaging()
  assert.equal(summaries.length, 1)
  assert.notEqual(requests[2].path, requests[0].path)
  assert.equal(
    requests[2].path,
    `/api/files/${JSON.parse(requests[3].body).sessions[0].messages[0].files[0].id}`
  )
})

test('oversize imports fail before uploads, and clearing history calls the remote cleanup route', async () => {
  await storage.clearStaging()
  await storage.addStagingSession({ ...snapshot, title: 'x'.repeat(1024 * 1024) })
  await storage.saveStagingFiles([{ id: 'file-1', blob: new Blob(['original']) }])
  let requests = []
  globalThis.fetch = async (path, init) => {
    requests.push({ path, ...init })
    return new Response(null, { status: 204 })
  }
  await assert.rejects(storage.commitStaging(), /1 MiB/)
  assert.equal(requests.length, 0)
  await storage.clearStaging()
  assert.deepEqual(await storage.commitStaging(), [])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/chats')
  assert.equal(requests[0].method, 'DELETE')
})

test('identity changes cancel queued writes and requests carry the expected user', async () => {
  const requests = []
  storage.setBackendUserId('user-alice')
  let releaseUpload
  const uploaded = new Promise((resolve) => {
    releaseUpload = resolve
  })
  globalThis.fetch = async (path, init) => {
    requests.push({ path, ...init })
    if (path.startsWith('/api/files/')) {
      await uploaded
    }
    return new Response(null, { status: 204 })
  }
  const first = storage.saveSession(snapshot, [{ id: 'file-1', blob: new Blob(['original']) }])
  const second = storage.saveSession(snapshot)
  await new Promise((resolve) => setImmediate(resolve))
  storage.setBackendUserId('user-bob')
  releaseUpload()
  const results = await Promise.allSettled([first, second])
  assert.ok(results.every((result) => result.status === 'rejected'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].headers.get('X-Chat-User-ID'), 'user-alice')
  storage.setBackendUserId(null)
})
