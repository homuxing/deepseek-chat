import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildArchive,
  createCloudHarness,
  sessionFile,
  chatMessage,
  fileReference,
  toFile,
} from './helpers/cloudHarness.mjs'

const rawSession = (id) =>
  sessionFile({
    id,
    title: id,
    messages: [chatMessage({ id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: id }] })],
  })

const withHarness = async (run) => {
  const harness = await createCloudHarness()
  try {
    await run(harness)
  } finally {
    await harness.dispose()
  }
}

test('小会话合为最多十六个的批次，四批同时请求，后台确认后更新真实进度', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('batch_concurrency')
    harness.setCurrentUser(user, { reset: true })
    const batches = []
    let active = 0
    let maximum = 0
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const stop = harness.intercept(async (request) => {
      if (request.method === 'POST' && /\/imports\/[^/]+\/chats$/.test(request.path)) {
        const batch = JSON.parse(request.init.body).sessions
        batches.push(batch)
        active++
        maximum = Math.max(maximum, active)
        await gate
        active--
      }
    })
    let importing
    let failure
    try {
      const zip = await buildArchive(harness.modules, {
        sessions: Array.from({ length: 65 }, (_, index) => rawSession(`batch-${index}`)),
      })
      importing = harness.modules.backup.importHistory(toFile(zip))
      importing.catch((error) => {
        failure = error
      })
      await harness.waitUntil(() => active === 4 || failure)
      if (failure) throw failure
      const progress = harness.modules.importProgress.useHistoryImportProgress.getState()
      assert.equal(progress.totalSessions, 65)
      assert.equal(progress.sessions, 0)
      assert.equal(progress.phase, 'processing')
      assert.equal(batches.length, 4)
      assert.ok(batches.every((batch) => batch.length === 16))
      release()
      assert.equal(await importing, 65)
      assert.equal(maximum, 4)
      assert.deepEqual(
        batches.map((batch) => batch.length),
        [16, 16, 16, 16, 1]
      )
      assert.equal(
        harness.requests.filter((request) => /^\/api\/storage\/uploads/.test(request.path)).length,
        0
      )
      assert.equal(
        harness.requests.some((request) => request.path === '/api/chats/imports/archive'),
        false
      )
      assert.equal(harness.modules.importProgress.useHistoryImportProgress.getState().sessions, 65)
      assert.equal(harness.modules.importProgress.useHistoryImportProgress.getState().phase, 'done')
    } finally {
      release()
      await importing?.catch(() => {})
      stop()
    }
  })
})

test('普通附件使用单次直接上传，四个附件请求同时进行且共享原件只写一次', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('file_concurrency')
    harness.setCurrentUser(user, { reset: true })
    const refs = Array.from({ length: 6 }, (_, index) =>
      fileReference(harness.modules, {
        sessionId: 'files',
        id: `file-${index}`,
        name: `${index}.txt`,
        bytes: `原件${index}`,
        isImage: false,
      })
    )
    const session = sessionFile({
      id: 'files',
      title: '附件',
      messages: [
        chatMessage({
          id: 1,
          role: 'USER',
          fragments: [
            { type: 'REQUEST', content: '文件' },
            { type: 'FILE', files: refs.map((ref) => ref.entry) },
          ],
        }),
      ],
    })
    let active = 0
    let maximum = 0
    let requests = 0
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const stop = harness.intercept(async (request) => {
      if (request.method === 'PUT' && /\/imports\/[^/]+\/files\//.test(request.path)) {
        assert.ok(request.init.body instanceof Blob)
        active++
        requests++
        maximum = Math.max(maximum, active)
        await gate
        active--
      }
    })
    let importing
    try {
      const zip = await buildArchive(harness.modules, {
        sessions: [session],
        originals: refs.map((ref) => ref.original),
      })
      importing = harness.modules.backup.importHistory(toFile(zip))
      let failure
      importing.catch((error) => {
        failure = error
      })
      await harness.waitUntil(() => active === 4 || failure, '附件并发条件未达到')
      if (failure) throw failure
      assert.equal(harness.modules.importProgress.useHistoryImportProgress.getState().files, 0)
      assert.equal(harness.modules.importProgress.useHistoryImportProgress.getState().totalFiles, 6)
      release()
      assert.equal(await importing, 1)
      assert.equal(requests, 6)
      assert.equal(maximum, 4)
      assert.equal(harness.files.multipartUploads.size, 0)
      assert.equal(
        harness.requests.some((request) => /^\/api\/storage\/uploads/.test(request.path)),
        false
      )
      assert.equal(harness.modules.importProgress.useHistoryImportProgress.getState().files, 6)
    } finally {
      release()
      await importing?.catch(() => {})
      stop()
    }
  })
})

test('未完整确认批次成功时停止导入、取消暂存并保留原有历史', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('invalid_batch_result')
    harness.setCurrentUser(user, { reset: true })
    const zip = await buildArchive(harness.modules, { sessions: [rawSession('invalid-result')] })
    const stop = harness.intercept((request) => {
      if (request.method === 'POST' && /\/imports\/[^/]+\/chats$/.test(request.path)) {
        return {
          response: new Response(JSON.stringify({ count: 1, sessions: [] }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        }
      }
    })
    try {
      await assert.rejects(
        harness.modules.backup.importHistory(toFile(zip)),
        /无法确认全部会话已保存/
      )
      assert.equal(
        harness.modules.importProgress.useHistoryImportProgress.getState().phase,
        'error'
      )
      assert.equal(harness.modules.importProgress.useHistoryImportProgress.getState().sessions, 0)
      assert.ok(
        harness.requests.some(
          (request) => request.method === 'DELETE' && /\/imports\//.test(request.path)
        )
      )
      assert.deepEqual((await harness.snapshotAs(user)).sessions, [])
    } finally {
      stop()
    }
  })
})

test('非法 ZIP 在本地拒绝，不创建导入或上传请求', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('invalid_local_zip')
    harness.setCurrentUser(user, { reset: true })
    await assert.rejects(
      harness.modules.backup.importHistory(toFile(new Uint8Array([1, 2, 3, 4]))),
      /无法识别/
    )
    assert.equal(
      harness.requests.filter((request) => request.method === 'POST' || request.method === 'PUT')
        .length,
      0
    )
    assert.equal(harness.modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
  })
})
