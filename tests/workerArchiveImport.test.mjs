import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCloudTestModules,
  buildArchive,
  sessionFile,
  chatMessage,
  fileReference,
  toFile,
} from './helpers/cloudHarness.mjs'
import { createWorkerCloudHarness, removeWorkerCloudBundle } from './helpers/workerCloudHarness.mjs'

test(
  '真实 Worker 接收浏览器解析后的批量会话与附件，原子提交并保持账号隔离',
  { timeout: 120_000 },
  async () => {
    const modules = await buildCloudTestModules()
    const harness = await createWorkerCloudHarness()
    const previousFetch = globalThis.fetch
    try {
      await harness.initialize()
      const alice = await harness.addAccount('browser_alice')
      const bob = await harness.addAccount('browser_bob')
      const aliceSocket = await harness.openSync(alice)
      const bobSocket = await harness.openSync(bob)
      const ref = fileReference(modules, {
        sessionId: 'browser-chat',
        id: 'original-file',
        name: '文档.txt',
        bytes: '原件内容',
        isImage: false,
      })
      const content = '中文正文'.repeat(20000)
      const source = sessionFile({
        id: 'browser-chat',
        title: '完整导入',
        pinned: true,
        messages: [
          chatMessage({
            id: 1,
            role: 'USER',
            fragments: [
              { type: 'REQUEST', content: '问题' },
              { type: 'FILE', files: [ref.entry] },
            ],
          }),
          chatMessage({
            id: 2,
            parentId: 1,
            role: 'ASSISTANT',
            fragments: [{ type: 'RESPONSE', content }],
          }),
        ],
      })
      const zip = await buildArchive(modules, {
        sessions: [
          source,
          ...Array.from({ length: 17 }, (_, index) =>
            sessionFile({
              id: `small-${index}`,
              title: `小会话 ${index}`,
              messages: [
                chatMessage({
                  id: 1,
                  role: 'USER',
                  fragments: [{ type: 'REQUEST', content: '问题' }],
                }),
              ],
            })
          ),
        ],
        originals: [ref.original],
        originalsFirst: true,
      })
      const requests = []
      globalThis.fetch = async (path, init) => {
        requests.push({ path: String(path), method: init?.method ?? 'GET' })
        return harness.api(alice, String(path), init)
      }
      modules.backend.setBackendUserId(alice.id)
      modules.store.resetChatState()
      assert.equal(await modules.backup.importHistory(toFile(zip)), 18)
      const progress = modules.importProgress.useHistoryImportProgress.getState()
      assert.equal(progress.phase, 'done')
      assert.equal(progress.sessions, 18)
      assert.equal(progress.totalSessions, 18)
      assert.equal(progress.files, 1)
      assert.equal(progress.totalFiles, 1)
      assert.ok(
        requests.some(
          (request) => /\/imports\/[^/]+\/files\//.test(request.path) && request.method === 'PUT'
        )
      )
      assert.equal(
        requests.filter((request) => /\/imports\/[^/]+\/chats$/.test(request.path)).length,
        2
      )
      assert.equal(
        requests.some((request) => request.path === '/api/chats/imports/archive'),
        false
      )
      await aliceSocket.waitForType('changed')
      assert.equal(bobSocket.hasUnread('changed'), false)
      const loaded = (await harness.expectApi(alice, '/api/chats/browser-chat')).value.session
      assert.equal(loaded.messages[1].blocks[0].text, content)
      assert.equal(loaded.pinned, true)
      const fileId = loaded.messages[0].files[0].id
      const original = await harness.api(alice, '/api/files/' + fileId)
      assert.equal(await original.text(), '原件内容')
      assert.equal((await harness.api(bob, '/api/files/' + fileId)).status, 404)
      assert.deepEqual(await harness.query('PRAGMA foreign_key_check'), [])
      const before = requests.length
      await assert.rejects(
        modules.backup.importHistory(toFile(new Uint8Array([1, 2, 3, 4]))),
        /无法识别/
      )
      assert.equal(requests.length, before)
      const directory = (await harness.expectApi(alice, '/api/chats')).value.sessions
      assert.equal(directory.length, 18)
      assert.ok(directory.some((session) => session.id === 'browser-chat'))
    } finally {
      globalThis.fetch = previousFetch
      modules.store.resetChatState()
      modules.backend.setBackendUserId(null)
      await harness.dispose()
      await removeWorkerCloudBundle()
    }
  }
)
