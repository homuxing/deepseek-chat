import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  buildArchive,
  chatMessage,
  createCloudHarness,
  fileReference,
  iso,
  sessionFile,
  toFile,
} from './helpers/cloudHarness.mjs'

const withHarness = async (run) => {
  const harness = await createCloudHarness()
  try {
    return await run(harness)
  } finally {
    await harness.dispose()
  }
}

const plain = (value) => JSON.parse(JSON.stringify(value))

const assertDone = (progress, sessions, files, totalSessions = sessions, totalFiles = files) => {
  assert.equal(progress.phase, 'done')
  assert.equal(progress.sessions, sessions)
  assert.equal(progress.files, files)
  assert.equal(progress.totalSessions, totalSessions)
  assert.equal(progress.totalFiles, totalFiles)
  assert.equal(progress.error, undefined)
}

const importStarts = (harness) =>
  harness.requests.filter(
    (request) => request.method === 'POST' && request.path === '/api/chats/imports'
  )

const importDeletes = (harness) =>
  harness.requests.filter(
    (request) => request.method === 'DELETE' && /^\/api\/chats\/imports\/[^/]+$/.test(request.path)
  )

const commitRequests = (harness) =>
  harness.requests.filter(
    (request) =>
      request.method === 'POST' && /^\/api\/chats\/imports\/[^/]+\/commit$/.test(request.path)
  )

const sessionRequests = (harness) =>
  harness.requests.filter(
    (request) =>
      request.method === 'POST' && /^\/api\/chats\/imports\/[^/]+\/chats$/.test(request.path)
  )

const fileRequests = (harness) =>
  harness.requests.filter(
    (request) =>
      request.method === 'PUT' && /^\/api\/chats\/imports\/[^/]+\/files\/[^/]+$/.test(request.path)
  )

const resultRequests = (harness) =>
  harness.requests.filter(
    (request) =>
      request.method === 'GET' && /^\/api\/chats\/imports\/[^/]+\/result$/.test(request.path)
  )

const archivePosts = (harness) =>
  harness.requests.filter(
    (request) => request.method === 'POST' && request.path === '/api/chats/imports/archive'
  )

const localSession = (modules, session, fileTypes = new Map()) => {
  const local = modules.toLocalSession(session).session
  for (const message of local.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      file.mimeType = fileTypes.get(file.id) ?? ''
    }
  }
  return plain(local)
}

const assertSession = (actual, expected) => {
  assert.ok(actual, `missing imported session ${expected.id}`)
  assert.equal(actual.id, expected.id)
  assert.equal(actual.title, expected.title)
  assert.equal(Boolean(actual.pinned), Boolean(expected.pinned))
  assert.equal(actual.createdAt, expected.createdAt)
  assert.equal(actual.updatedAt, expected.updatedAt)
  const expectedMessages = plain(expected.messages)
  for (const expectedMessage of expectedMessages) {
    if (expectedMessage.role !== 'user') {
      continue
    }
    const actualMessage = actual.messages.find((message) => message.id === expectedMessage.id)
    for (const expectedFile of expectedMessage.files) {
      const actualFile = actualMessage.files.find((file) => file.name === expectedFile.name)
      assert.ok(actualFile, `missing remapped file ${expectedFile.name}`)
      expectedFile.id = actualFile.id
    }
  }
  assert.deepEqual(actual.messages, expectedMessages)
  assert.equal(actual.rootMessageId, expected.rootMessageId ?? null)
}

const makeSession = ({
  id,
  title = `Synthetic session ${id}`,
  pinned = false,
  base = 1_700_000_000_000,
  largeAnswer = '',
  files = [],
}) => {
  const userFragments = [
    ...(files.length > 0 ? [{ type: 'FILE', files }] : []),
    { type: 'REQUEST', content: `Question for ${id}` },
  ]
  return sessionFile({
    id,
    title,
    pinned,
    currentMessageId: 4,
    insertedAt: iso(base),
    updatedAt: iso(base + 10_000),
    messages: [
      chatMessage({
        id: 1,
        role: 'USER',
        fragments: userFragments,
        insertedAt: iso(base + 1_000),
      }),
      chatMessage({
        id: 2,
        parentId: 1,
        role: 'ASSISTANT',
        search: true,
        fragments: [
          { type: 'THINK', content: `Reasoning for ${id}`, elapsed_secs: 1.25 },
          { type: 'RESPONSE', content: `Answer for ${id}` },
          {
            type: 'TOOL_SEARCH',
            queries: [`query ${id}`],
            status: 'FINISHED',
            results: [
              {
                url: 'https://example.com/result',
                title: 'Synthetic result',
                snippet: 'Synthetic snippet',
                published_at: null,
                site_name: 'Example',
                site_icon: null,
              },
            ],
          },
        ],
        insertedAt: iso(base + 2_000),
      }),
      chatMessage({
        id: 3,
        parentId: 2,
        role: 'USER',
        fragments: [{ type: 'REQUEST', content: `Continue ${id}` }],
        insertedAt: iso(base + 3_000),
      }),
      chatMessage({
        id: 4,
        parentId: 3,
        role: 'ASSISTANT',
        fragments: [{ type: 'RESPONSE', content: largeAnswer || `Current answer ${id}` }],
        insertedAt: iso(base + 4_000),
      }),
      chatMessage({
        id: 5,
        parentId: 3,
        role: 'ASSISTANT',
        fragments: [{ type: 'RESPONSE', content: `Alternate answer ${id}` }],
        insertedAt: iso(base + 5_000),
      }),
    ],
  })
}

const seedSession = async (harness, user, session, expectedRevision = 0) => {
  const result = await harness.saveSessionAs(user, session, { expectedRevision })
  assert.equal(result.complete?.status, 200, await result.complete?.text())
  return result.completed.summary
}

const mutationRequests = (harness, user) =>
  harness.requests.filter(
    (request) =>
      request.user.id === user.id && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
  )

test('非法 ZIP 在本地检查阶段失败且不产生任何网络请求', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('local_invalid')
    harness.setCurrentUser(user, { reset: true })
    await modules.store.initChat()
    const before = harness.requests.length
    const broken = toFile(new Uint8Array([0x4e, 0x4f, 0x54, 0x5a, 0x49, 0x50]), 'broken.zip')
    await assert.rejects(modules.backup.importHistory(broken))
    assert.equal(harness.requests.length, before)
    assert.equal(archivePosts(harness).length, 0)
    assert.equal(importStarts(harness).length, 0)
    assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    assert.equal(modules.store.useChatStore.getState().importingHistory, false)
  })
})

test('导入全过程绑定离开页面提醒，失败后移除提醒并保留历史', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('leave_protection')
    harness.setCurrentUser(user, { reset: true })
    await modules.store.initChat()
    const originalWindow = globalThis.window
    const page = new EventTarget()
    globalThis.window = page
    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'leave-protected' })],
    })
    const rejectChats = harness.intercept((request) => {
      if (request.method === 'POST' && /\/chats$/.test(request.path)) {
        return {
          response: new Response(JSON.stringify({ error: { message: '文件内容无效' } }), {
            status: 400,
          }),
        }
      }
    })
    try {
      const importing = modules.backup.importHistory(toFile(archive))
      const leaving = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(leaving)
      assert.equal(leaving.defaultPrevented, true)
      await assert.rejects(importing, /文件内容无效/)
      const afterFailure = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(afterFailure)
      assert.equal(afterFailure.defaultPrevented, false)
      assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
      assert.equal(modules.store.useChatStore.getState().importingHistory, false)
      assert.equal(importDeletes(harness).length, 1)
      assert.equal(commitRequests(harness).length, 0)
      assert.deepEqual((await harness.snapshotAs(user)).sessions, [])
      rejectChats()
      assert.equal(await modules.backup.importHistory(toFile(archive)), 1)
      const afterSuccess = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(afterSuccess)
      assert.equal(afterSuccess.defaultPrevented, false)
      assertDone(modules.importProgress.useHistoryImportProgress.getState(), 1, 0)
    } finally {
      rejectChats()
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    }
  })
})

test('小会话按最多十六个且不超过 240 KiB 合批保存，进度使用本地目录总数', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('batch_counts')
    harness.setCurrentUser(user, { reset: true })
    const sessions = Array.from({ length: 20 }, (_, index) =>
      makeSession({ id: `batch-${index}`, largeAnswer: 'x'.repeat(6_000) })
    )
    const archive = await buildArchive(modules, { sessions })
    const progress = []
    const unsubscribe = modules.importProgress.useHistoryImportProgress.subscribe((state) =>
      progress.push(plain(state))
    )
    assert.equal(await modules.backup.importHistory(toFile(archive)), 20)
    unsubscribe()
    const batches = sessionRequests(harness)
    assert.ok(batches.length >= 2)
    for (const request of batches) {
      const batch = request.body?.sessions
      assert.ok(Array.isArray(batch))
      assert.ok(batch.length >= 1 && batch.length <= 16)
      assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 240 * 1024)
    }
    assert.equal(
      batches.reduce((sum, request) => sum + request.body.sessions.length, 0),
      20
    )
    assert.deepEqual(
      batches.flatMap((request) => request.body.sessions.map((session) => session.id)).sort(),
      sessions.map((session) => session.id).sort()
    )
    assert.ok(
      progress.some(
        (state) =>
          state.phase === 'processing' && state.totalSessions === 20 && state.totalFiles === 0
      ),
      '目录校验后应写入真实总数'
    )
    assertDone(modules.importProgress.useHistoryImportProgress.getState(), 20, 0)
    assert.equal(commitRequests(harness)[0].body.count, 20)
    assert.equal(fileRequests(harness).length, 0)
  })
})

test('大型会话单条上传，进度只在真实保存后增加，提交使用完整目录返回', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('large_session')
    harness.setCurrentUser(user, { reset: true })
    const sessions = [
      makeSession({ id: 'large-one', largeAnswer: 'x'.repeat(400_000) }),
      makeSession({ id: 'small-one' }),
    ]
    assert.ok(Buffer.byteLength(JSON.stringify(sessions[0])) > 256 * 1024)
    const archive = await buildArchive(modules, { sessions })
    const progress = []
    const unsubscribe = modules.importProgress.useHistoryImportProgress.subscribe((state) =>
      progress.push(plain(state))
    )
    assert.equal(await modules.backup.importHistory(toFile(archive)), 2)
    unsubscribe()
    assertDone(modules.importProgress.useHistoryImportProgress.getState(), 2, 0)
    assert.ok(
      progress.some((state) => state.phase === 'processing' && state.sessions === 1),
      '保存完成后应更新已完成会话数'
    )
    assert.ok(
      progress.some((state) => state.phase === 'processing' && state.sessions === 2),
      '全部保存完成后应更新已完成会话数'
    )
    const commit = commitRequests(harness)[0]
    assert.equal(commit.body.count, 2)
    assert.equal(commit.status, 200)
    assert.deepEqual(commit.body.sessions.map((session) => session.id).sort(), [
      'large-one',
      'small-one',
    ])
    assert.equal(
      harness.requests.filter(
        (request) =>
          request.method === 'GET' && /^\/api\/chats\/imports\/[^/]+\/result$/.test(request.path)
      ).length,
      0
    )
    assert.deepEqual(
      (await harness.snapshotAs(user)).sessions.map((session) => session.id).sort(),
      ['large-one', 'small-one']
    )
  })
})

test('后端提交响应丢失后按本次任务恢复，不重复上传或另建任务', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('lost_commit_response')
    harness.setCurrentUser(user, { reset: true })
    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'commit-recovered' })],
    })
    let lost = false
    const stop = harness.intercept((request) => {
      if (
        !lost &&
        request.method === 'POST' &&
        /^\/api\/chats\/imports\/[^/]+\/commit$/.test(request.path)
      ) {
        lost = true
        return {
          afterResponse() {
            throw new TypeError('simulated connection reset')
          },
        }
      }
    })
    try {
      assert.equal(await modules.backup.importHistory(toFile(archive)), 1)
    } finally {
      stop()
    }
    assertDone(modules.importProgress.useHistoryImportProgress.getState(), 1, 0)
    assert.equal(importStarts(harness).length, 1)
    assert.equal(commitRequests(harness).length, 1)
    assert.equal(importDeletes(harness).length, 0)
    assert.deepEqual(
      (await harness.snapshotAs(user)).sessions.map((session) => session.id),
      ['commit-recovered']
    )
  })
})

test('会话批处理和附件直接上传共用四任务并发上限', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('four_tasks')
    harness.setCurrentUser(user, { reset: true })
    const references = Array.from({ length: 6 }, (_, index) =>
      fileReference(modules, {
        sessionId: 'gate-session',
        id: `gate-file-${index}`,
        name: `gate-${index}.png`,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]),
        isImage: true,
      })
    )
    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'gate-session', files: references.map((item) => item.entry) })],
      originals: references.map((item) => item.original),
    })
    const seen = new Set()
    let active = 0
    let peak = 0
    const gate = harness.gate()
    const stop = harness.intercept(async (request) => {
      let key
      if (request.method === 'POST' && /\/chats$/.test(request.path)) {
        key = `chat:${request.body?.sessions?.[0]?.id}`
      } else if (request.method === 'PUT' && /\/files\//.test(request.path)) {
        key = `file:${request.path.split('/').at(-1)}`
      } else {
        return
      }
      if (seen.has(key)) return
      seen.add(key)
      active++
      peak = Math.max(peak, active)
      if (active === 4) gate.markEntered()
      await gate.wait
      active--
    })
    const importing = modules.backup.importHistory(toFile(archive))
    try {
      await gate.entered
      assert.equal(peak, 4)
      assert.equal(active, 4)
      gate.release()
      assert.equal(await importing, 1)
    } finally {
      gate.release()
      await importing.catch(() => undefined)
      stop()
    }
    assert.equal(peak, 4)
    assert.equal(seen.size, 7)
    assertDone(modules.importProgress.useHistoryImportProgress.getState(), 1, 6)
    assert.equal(harness.files.multipartUploads.size, 0)
  })
})

test('原件超过 8 MiB 时回退 multipart，小附件继续直接 PUT', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('multipart_file')
    harness.setCurrentUser(user, { reset: true })
    const big = new Uint8Array(8 * 1024 * 1024 + 9_331)
    big.fill(0x41)
    const smallBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const bigFile = fileReference(modules, {
      sessionId: 'mixed-files',
      id: 'big-original',
      name: 'big.bin',
      bytes: big,
      isImage: false,
    })
    const smallFile = fileReference(modules, {
      sessionId: 'mixed-files',
      id: 'small-original',
      name: 'small.png',
      bytes: smallBytes,
      isImage: true,
    })
    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'mixed-files', files: [bigFile.entry, smallFile.entry] })],
      originals: [bigFile.original, smallFile.original],
    })
    assert.equal(await modules.backup.importHistory(toFile(archive)), 1)
    assertDone(modules.importProgress.useHistoryImportProgress.getState(), 1, 2)
    assert.equal(fileRequests(harness).length, 1)
    assert.ok(
      harness.requests.some((request) =>
        /^\/api\/storage\/uploads\/[^/]+\/parts\//.test(request.path)
      )
    )
    assert.equal((await harness.loadSessionAs(user, 'mixed-files')).messages[0].files.length, 2)
  })
})

test('附件保存失败后第一个错误取消兄弟任务，在途任务结束后删除导入任务', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('first_error')
    harness.setCurrentUser(user, { reset: true })
    const references = Array.from({ length: 6 }, (_, index) =>
      fileReference(modules, {
        sessionId: 'error-session',
        id: `error-file-${index}`,
        name: `error-${index}.png`,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]),
        isImage: true,
      })
    )
    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'error-session', files: references.map((item) => item.entry) })],
      originals: references.map((item) => item.original),
    })
    const gate = harness.gate()
    let first = true
    let inFlight = 0
    const stop = harness.intercept(async (request) => {
      if (request.method !== 'PUT' || !/\/files\//.test(request.path)) return
      const isFirst = first
      first = false
      if (!isFirst) {
        inFlight++
        await gate.wait
        inFlight--
        return
      }
      gate.markEntered()
      await gate.wait
      return {
        response: new Response(
          JSON.stringify({ error: { message: 'injected first file failure' } }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        ),
      }
    })
    const importing = modules.backup.importHistory(toFile(archive))
    try {
      await gate.entered
      gate.release()
      await assert.rejects(importing, /injected first file failure/)
    } finally {
      gate.release()
      await importing.catch(() => undefined)
      stop()
    }
    assert.equal(inFlight, 0)
    assert.equal(commitRequests(harness).length, 0)
    assert.equal(importDeletes(harness).length, 1)
    assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    assert.deepEqual((await harness.snapshotAs(user)).sessions, [])
    assert.equal(
      await modules.backup.importHistory(
        toFile(await buildArchive(modules, { sessions: [makeSession({ id: 'retry-ok' })] }))
      ),
      1
    )
  })
})

test('解析阶段切换账号中止导入，取消请求拒绝身份校验且不写入新账号', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const alice = await harness.addUser('identity_alice')
    const bob = await harness.addUser('identity_bob')
    const aliceOld = localSession(
      modules,
      makeSession({ id: 'alice-old', title: 'Alice old', base: 1_670_000_000_000 })
    )
    const bobOldRaw = makeSession({ id: 'bob-old', title: 'Bob old', base: 1_671_000_000_000 })
    bobOldRaw.messages[0].fragments.find((fragment) => fragment.type === 'REQUEST').content =
      '**bold retained**'
    const bobOld = localSession(modules, bobOldRaw)
    await seedSession(harness, alice, aliceOld)
    await seedSession(harness, bob, bobOld)
    harness.setCurrentUser(alice, { reset: true })
    await modules.store.initChat()

    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'alice-new', title: 'Alice new' })],
    })
    const gate = harness.gate()
    const stop = harness.intercept(async (request) => {
      if (request.method === 'POST' && /\/chats$/.test(request.path)) {
        gate.markEntered()
        await gate.wait
      }
    })
    const importing = modules.backup.importHistory(toFile(archive))
    try {
      await gate.entered
      harness.setCurrentUser(bob, { reset: true })
      gate.release()
      await assert.rejects(importing, /账号已变更|取消/)
      assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    } finally {
      gate.release()
      await importing.catch(() => undefined)
      stop()
    }
    assert.equal(mutationRequests(harness, bob).length, 0)
    await modules.store.initChat()
    assert.deepEqual(
      modules.store.useChatStore.getState().sessions.map((session) => session.id),
      ['bob-old']
    )
    assert.match(
      (await harness.loadSessionAs(bob, 'bob-old')).messages[0].content,
      /\*\*bold retained\*\*/
    )
    assert.deepEqual(
      (await harness.snapshotAs(alice)).sessions.map((session) => session.id),
      ['alice-old']
    )
  })
})

test('处理阶段保留离开提醒，账号切换后取消并清理提醒', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('waiting_user')
    const other = await harness.addUser('waiting_other')
    harness.setCurrentUser(user, { reset: true })
    const previousWindow = globalThis.window
    const page = new EventTarget()
    globalThis.window = page
    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'wait-cancel' })],
    })
    const gate = harness.gate()
    const stop = harness.intercept(async (request) => {
      if (request.method === 'POST' && /\/chats$/.test(request.path)) {
        gate.markEntered()
        await gate.wait
      }
    })
    let importing
    try {
      importing = modules.backup.importHistory(toFile(archive))
      await gate.entered
      const during = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(during)
      assert.equal(during.defaultPrevented, true)
      harness.setCurrentUser(other, { reset: true })
      gate.release()
      await assert.rejects(importing, /账号已变更|取消/)
      assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
      const after = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(after)
      assert.equal(after.defaultPrevented, false)
      assert.equal(mutationRequests(harness, other).length, 0)
    } finally {
      gate.release()
      if (importing) await importing.catch(() => undefined)
      stop()
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
    }
  })
})

test('仅恢复临时传输失败，文件内容、权限和数据冲突错误如实报告', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const { backend, importTransport } = modules
    assert.equal(importTransport.isImportConnectionError(new TypeError('程序错误')), false)
    assert.equal(
      importTransport.isImportConnectionError(new DOMException('源文件不可读', 'NotFoundError')),
      false
    )
    assert.equal(
      importTransport.isImportConnectionError(
        new backend.BackendConnectionError(new TypeError('连接中断'))
      ),
      true
    )
    for (const status of [408, 429, 502, 503, 504]) {
      assert.equal(
        importTransport.isImportConnectionError(new backend.BackendError('临时失败', status)),
        true
      )
    }
    for (const status of [400, 401, 403, 404, 409, 413, 500]) {
      assert.equal(
        importTransport.isImportConnectionError(new backend.BackendError('永久失败', status)),
        false
      )
    }

    const user = await harness.addUser('permanent_error')
    harness.setCurrentUser(user, { reset: true })
    const archive = await buildArchive(modules, { sessions: [makeSession({ id: 'permanent' })] })
    const stop = harness.intercept((request) => {
      if (request.method === 'POST' && /\/chats$/.test(request.path)) {
        return {
          response: new Response(JSON.stringify({ error: { message: '数据冲突' } }), {
            status: 409,
          }),
        }
      }
    })
    try {
      await assert.rejects(modules.backup.importHistory(toFile(archive)), /数据冲突/)
    } finally {
      stop()
    }
    assert.equal(
      sessionRequests(harness).filter((request) => request.status === 409).length >= 1,
      true
    )
    assert.equal(importStarts(harness).length, 1)
    assert.equal(commitRequests(harness).length, 0)
  })
})

test('暂存内容在提交前不可见，提交后原子切换并支持导出再导入', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('switch_user')
    const oldRaw = makeSession({
      id: 'old-session',
      title: 'Old history',
      base: 1_690_000_000_000,
    })
    const oldSession = localSession(modules, oldRaw)
    await seedSession(harness, user, oldSession)
    harness.setCurrentUser(user, { reset: true })
    await modules.store.initChat()

    const sessions = ['new-alpha', 'new-beta', 'new-gamma'].map((id, index) =>
      makeSession({
        id,
        title: `Imported ${id}`,
        pinned: index === 1,
        base: 1_710_000_000_000 + index * 100_000,
      })
    )
    const archive = await buildArchive(modules, { sessions })
    const gate = harness.gate()
    const stop = harness.intercept(async (request) => {
      if (request.method === 'POST' && /\/chats$/.test(request.path)) {
        gate.markEntered()
        await gate.wait
      }
    })
    const importing = modules.backup.importHistory(toFile(archive))
    try {
      await gate.entered
      await assert.rejects(modules.backup.importHistory(toFile(archive)), /正在导入历史/)
      assert.equal(importStarts(harness).length, 1)
      assert.equal(modules.store.useChatStore.getState().importingHistory, true)
      assert.deepEqual(
        modules.store.useChatStore.getState().sessions.map((session) => session.id),
        ['old-session']
      )
      assert.deepEqual(
        (await harness.snapshotAs(user)).sessions.map((session) => session.id),
        ['old-session']
      )
      gate.release()
      assert.equal(await importing, 3)
    } finally {
      gate.release()
      await importing.catch(() => undefined)
      stop()
    }
    assertDone(modules.importProgress.useHistoryImportProgress.getState(), 3, 0)
    assert.deepEqual(
      (await harness.snapshotAs(user)).sessions.map((session) => session.id).sort(),
      ['new-alpha', 'new-beta', 'new-gamma']
    )
    const fresh = await harness.freshModules()
    fresh.backend.setBackendUserId(user.id)
    fresh.store.resetChatState()
    await fresh.store.initChat()
    assert.deepEqual(
      fresh.store.useChatStore
        .getState()
        .sessions.map((session) => session.id)
        .sort(),
      ['new-alpha', 'new-beta', 'new-gamma']
    )
    const beforeExport = await harness.loadAllSessionsAs(user)
    const exported = await modules.backup.exportHistory()
    assert.match(exported.name, /^deepseek_data-\d{4}-\d{2}-\d{2}\.zip$/)
    assert.equal(await modules.backup.importHistory(toFile(exported.blob, exported.name)), 3)
    const afterRoundtrip = await harness.loadAllSessionsAs(user)
    const expected = new Map(
      sessions.map((session) => [session.id, localSession(modules, session)])
    )
    for (const session of beforeExport.sessions) {
      assert.deepEqual(
        afterRoundtrip.sessions.find((item) => item.id === session.id).messages,
        session.messages
      )
      assertSession(session, expected.get(session.id))
    }
  })
})

test('解析后数据库失败不发布新历史，已有会话保持原样', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('failure_user')
    const oldSession = localSession(
      modules,
      makeSession({ id: 'keep-old', title: 'Keep old', base: 1_680_000_000_000 })
    )
    await seedSession(harness, user, oldSession)
    harness.setCurrentUser(user, { reset: true })
    await modules.store.initChat()
    const original = await harness.snapshotAs(user)
    const beforeInvalid = harness.requests.length

    await assert.rejects(
      modules.backup.importHistory(
        toFile(new Uint8Array([0x4e, 0x4f, 0x54, 0x5a, 0x49, 0x50]), 'broken.zip')
      )
    )
    assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    assert.equal(harness.requests.length, beforeInvalid)
    assert.deepEqual((await harness.snapshotAs(user)).sessions, original.sessions)

    const insertArchive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'not-published-1', title: 'Not published 1' })],
    })
    harness.db.failNext(/INSERT INTO chats/i, new Error('injected chats insert'))
    await assert.rejects(modules.backup.importHistory(toFile(insertArchive)))
    assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    assert.deepEqual((await harness.snapshotAs(user)).sessions, original.sessions)
    assert.deepEqual(
      modules.store.useChatStore.getState().sessions.map((session) => session.id),
      ['keep-old']
    )
    assert.equal(importDeletes(harness).length > 0, true)
  })
})

test('导入开始后的另一设备写入使提交返回 409，并完整保留新数据', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('concurrent_user')
    const oldSession = localSession(
      modules,
      makeSession({ id: 'concurrent-old', title: 'Concurrent old', base: 1_660_000_000_000 })
    )
    await seedSession(harness, user, oldSession)
    harness.setCurrentUser(user, { reset: true })
    await modules.store.initChat()

    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'import-losing-race', title: 'Should not win' })],
    })
    const gate = harness.gate()
    const stop = harness.intercept(async (request) => {
      if (request.method === 'POST' && /\/chats$/.test(request.path)) {
        gate.markEntered()
        await gate.wait
      }
    })
    const importing = modules.backup.importHistory(toFile(archive))
    try {
      await gate.entered
      const concurrent = localSession(
        modules,
        makeSession({
          id: 'concurrent-new',
          title: 'Other device wins',
          base: 1_661_000_000_000,
        })
      )
      await seedSession(harness, user, concurrent)
      gate.release()
      const error = await importing.catch((reason) => reason)
      assert.ok(error instanceof Error)
      assert.equal(error.status, 409)
      assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
      assert.deepEqual(
        (await harness.snapshotAs(user)).sessions.map((session) => session.id).sort(),
        ['concurrent-new', 'concurrent-old']
      )
      assert.equal(
        (await harness.snapshotAs(user)).sessions.some(
          (session) => session.id === 'import-losing-race'
        ),
        false
      )
    } finally {
      gate.release()
      await importing.catch(() => undefined)
      stop()
    }
  })
})

test('同一会话使用过期 revision 保存返回 409，新内容不被覆盖并标记冲突', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('revision_user')
    const initial = localSession(
      modules,
      makeSession({ id: 'versioned-session', title: 'Initial', base: 1_650_000_000_000 })
    )
    const initialSummary = await seedSession(harness, user, initial)

    const first = structuredClone(initial)
    first.title = 'Device one'
    first.updatedAt += 1
    const firstResult = await harness.saveSessionAs(user, first, {
      expectedRevision: initialSummary.revision,
    })
    assert.equal(firstResult.complete.status, 200)

    const stale = structuredClone(initial)
    stale.title = 'Stale device two'
    stale.updatedAt += 2
    const staleResult = await harness.saveSessionAs(user, stale, {
      expectedRevision: initialSummary.revision,
    })
    assert.equal(staleResult.complete.status, 409)
    assert.match((await staleResult.complete.json()).error.message, /其他设备|版本|更新/)
    assert.equal((await harness.loadSessionAs(user, 'versioned-session')).title, 'Device one')

    const storeSeed = localSession(
      modules,
      makeSession({ id: 'store-conflict', title: 'Store initial', base: 1_651_000_000_000 })
    )
    const storeSeedSummary = await seedSession(harness, user, storeSeed)
    harness.setCurrentUser(user, { reset: true })
    await modules.store.initChat()
    modules.store.selectSession('store-conflict')
    await harness.waitUntil(() =>
      Boolean(modules.store.useChatStore.getState().sessionCache['store-conflict'])
    )

    const otherDevice = structuredClone(storeSeed)
    otherDevice.title = 'Other device title'
    otherDevice.updatedAt += 1
    const otherResult = await harness.saveSessionAs(user, otherDevice, {
      expectedRevision: storeSeedSummary.revision,
    })
    assert.equal(otherResult.complete.status, 200)

    modules.store.renameSession('store-conflict', 'Stale local edit')
    await harness.waitUntil(
      () => modules.store.useChatStore.getState().sessionConflictErrors['store-conflict'] === true
    )
    assert.equal(modules.store.useChatStore.getState().sessionSaveErrors['store-conflict'], true)
    assert.equal((await harness.loadSessionAs(user, 'store-conflict')).title, 'Other device title')
    assert.ok(
      harness.requests.some(
        (request) =>
          /\/complete$/.test(request.path) && request.method === 'POST' && request.status === 409
      )
    )
  })
})

test('普通会话完成响应丢失时查询上传状态，导入响应丢失时不另建任务', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('recovery_user')
    harness.setCurrentUser(user, { reset: true })
    await modules.store.initChat()

    const direct = localSession(
      modules,
      makeSession({ id: 'direct-upload', title: 'Direct upload', base: 1_640_000_000_000 })
    )
    let lostUploadCompletion = false
    harness.intercept((request) => {
      if (
        !lostUploadCompletion &&
        request.method === 'POST' &&
        /^\/api\/storage\/uploads\/[^/]+\/complete$/.test(request.path)
      ) {
        lostUploadCompletion = true
        return {
          afterResponse: () => {
            throw new Error('simulated lost upload completion response')
          },
        }
      }
    })
    const saved = await modules.db.saveSession(direct)
    assert.equal(saved.id, 'direct-upload')
    const uploadStatus = harness.requests.find(
      (request) => request.method === 'GET' && /^\/api\/storage\/uploads\/[^/]+$/.test(request.path)
    )
    assert.equal(uploadStatus?.status, 200)
    assert.equal(uploadStatus.body.status, 'completed')
    assert.equal(uploadStatus.body.summary.id, 'direct-upload')
    assert.deepEqual(
      (await harness.snapshotAs(user)).sessions.map((session) => session.id),
      ['direct-upload']
    )

    const archive = await buildArchive(modules, {
      sessions: [
        makeSession({
          id: 'recovered-import',
          title: 'Recovered import',
          pinned: true,
          base: 1_641_000_000_000,
        }),
      ],
    })
    let lostChatResponse = false
    const stopIntercept = harness.intercept((request) => {
      if (
        !lostChatResponse &&
        request.method === 'POST' &&
        /^\/api\/chats\/imports\/[^/]+\/chats$/.test(request.path)
      ) {
        lostChatResponse = true
        return {
          afterResponse: () => {
            throw new TypeError('simulated lost chat response')
          },
        }
      }
    })
    try {
      assert.equal(await modules.backup.importHistory(toFile(archive)), 1)
    } finally {
      stopIntercept()
    }
    assertDone(modules.importProgress.useHistoryImportProgress.getState(), 1, 0)
    const savedIds = new Set(
      sessionRequests(harness).flatMap(
        (request) => request.body?.sessions?.map((session) => session.id) ?? []
      )
    )
    assert.deepEqual([...savedIds], ['recovered-import'])
    assert.deepEqual(
      (await harness.snapshotAs(user)).sessions.map((session) => session.id).sort(),
      ['recovered-import']
    )
  })
})

const fixturePath = process.env.DEEPSEEK_IMPORT_FIXTURE
const fixtureAvailable = Boolean(fixturePath && existsSync(fixturePath))

test(
  '官方完整导出包在内存中完成全量导入并核对会话、消息和原件数量',
  {
    skip: fixtureAvailable ? false : 'DEEPSEEK_IMPORT_FIXTURE 未设置或文件不存在',
  },
  async () => {
    await withHarness(async (harness) => {
      const { modules } = harness
      const user = await harness.addUser('fixture_user')
      harness.setCurrentUser(user, { reset: true })
      modules.importProgress.resetHistoryImportProgress()
      const bytes = readFileSync(fixturePath)
      const archive = new File([bytes], 'official-deepseek-export.zip', {
        type: 'application/zip',
      })

      let sessionCount = 0
      let messageCount = 0
      let fileCount = 0
      let largestSessionBytes = 0
      let entryIndex = 0
      try {
        for await (const entry of modules.readArchive(archive)) {
          entryIndex += 1
          const sessionId = /^chat_sessions\/([^/]+)\.json$/.exec(entry.path)?.[1]
          if (sessionId) {
            const text = await (await modules.readEntry(entry)).text()
            const session = JSON.parse(text)
            sessionCount += 1
            messageCount += session.messages.length
            largestSessionBytes = Math.max(largestSessionBytes, Buffer.byteLength(text))
          } else if (modules.paths.parseOriginalPath(entry.path)) {
            fileCount += 1
            await modules.skipEntry(entry)
          } else {
            await modules.skipEntry(entry)
          }
        }
      } catch (error) {
        throw new Error(`official archive entry ${entryIndex} could not be read`, { cause: error })
      }
      assert.equal(sessionCount, 655)
      assert.equal(messageCount, 3654)
      assert.equal(fileCount, 94)
      assert.ok(largestSessionBytes > 900 * 1024)

      assert.equal(await modules.backup.importHistory(archive), 655)
      assertDone(modules.importProgress.useHistoryImportProgress.getState(), 655, 94)
      const snapshot = await harness.snapshotAs(user)
      assert.equal(snapshot.sessions.length, 655)
      let importedMessages = 0
      for (const summary of snapshot.sessions) {
        const session = await harness.loadSessionAs(user, summary.id)
        importedMessages += session.messages.length
      }
      assert.equal(importedMessages, 3654)
      assert.equal(
        harness.db.db.prepare('SELECT COUNT(*) AS count FROM files WHERE user_id = ?').get(user.id)
          .count,
        94
      )
      assert.equal(importStarts(harness).length, 1)
      assert.equal(
        harness.requests.filter(
          (request) =>
            request.method === 'GET' && /^\/api\/chats\/imports\/[^/]+\/result$/.test(request.path)
        ).length,
        0
      )
    })
  }
)
