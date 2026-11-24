import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildArchive,
  createCloudHarness,
  chatMessage,
  sessionFile,
  toFile,
} from './helpers/cloudHarness.mjs'

const raw = (id, content = '内容') =>
  sessionFile({
    id,
    title: id,
    messages: [chatMessage({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content }] })],
  })
const withHarness = async (run) => {
  const harness = await createCloudHarness()
  try {
    await run(harness)
  } finally {
    await harness.dispose()
  }
}

test('小会话批次按 UTF-8 字节控制大小，大会话独立上传且完整保留正文', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('utf8_batch')
    harness.setCurrentUser(user, { reset: true })
    const content = '中文'.repeat(24 * 1024)
    const larger = '大正文'.repeat(50 * 1024)
    const sessions = [
      raw('utf8-1', content),
      raw('utf8-2', content),
      raw('large', larger),
      raw('last'),
    ]
    const zip = await buildArchive(harness.modules, { sessions })
    assert.equal(await harness.modules.backup.importHistory(toFile(zip)), 4)
    const batches = harness.requests.filter(
      (request) => request.method === 'POST' && /\/imports\/[^/]+\/chats$/.test(request.path)
    )
    assert.equal(batches.length, 3)
    const starts = harness.requests.filter(
      (request) => request.method === 'POST' && request.path === '/api/storage/uploads'
    )
    assert.equal(starts.length, 1)
    const loaded = await harness.loadAllSessionsAs(user)
    assert.equal(
      loaded.sessions.find((session) => session.id === 'large').messages[0].content,
      larger
    )
    assert.equal(
      loaded.sessions.find((session) => session.id === 'utf8-1').messages[0].content,
      content
    )
    assert.equal(harness.modules.importProgress.useHistoryImportProgress.getState().sessions, 4)
  })
})

test('取消期间等待所有在途请求，第一项失败不发布已暂存的其他会话', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('batch_failure')
    harness.setCurrentUser(user, { reset: true })
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let active = 0
    let entered = 0
    const stop = harness.intercept(async (request) => {
      if (request.method === 'POST' && /\/imports\/[^/]+\/chats$/.test(request.path)) {
        entered++
        active++
        await gate
        active--
        if (JSON.parse(request.init.body).sessions[0].id === 'fail-0') {
          return {
            response: new Response(JSON.stringify({ error: { message: '批次保存失败' } }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }),
          }
        }
      }
    })
    let importing
    try {
      const zip = await buildArchive(harness.modules, {
        sessions: Array.from({ length: 80 }, (_, index) => raw(`fail-${index}`)),
      })
      importing = harness.modules.backup.importHistory(toFile(zip))
      await harness.waitUntil(() => entered === 4)
      release()
      await assert.rejects(importing, /批次保存失败/)
      assert.equal(active, 0)
      assert.equal(entered, 4)
      assert.deepEqual((await harness.snapshotAs(user)).sessions, [])
      assert.equal(
        harness.requests.some((request) => /\/commit$/.test(request.path)),
        false
      )
      assert.ok(
        harness.requests.some(
          (request) => request.method === 'DELETE' && /\/imports\//.test(request.path)
        )
      )
    } finally {
      release()
      await importing?.catch(() => {})
      stop()
    }
  })
})
