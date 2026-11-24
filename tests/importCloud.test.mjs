import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  buildArchive,
  chatMessage,
  createCloudHarness,
  fileReference,
  iso,
  jsonBlob,
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
    const rejectPart = harness.intercept((request) => {
      if (request.method === 'PUT' && /\/parts\/1$/.test(request.path)) {
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
      assert.equal(harness.files.multipartUploads.size, 0)
      assert.ok(
        harness.requests
          .filter((request) => request.status !== null)
          .every((request) => request.status < 500)
      )
      rejectPart()
      const success = modules.backup.importHistory(toFile(archive))
      assert.equal(await success, 1)
      const afterSuccess = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(afterSuccess)
      assert.equal(afterSuccess.defaultPrevented, false)
    } finally {
      rejectPart()
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    }
  })
})

test('上传开始后原 ZIP 不可读取，完整副本仍能完成后续对话和附件导入', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('stable_source')
    harness.setCurrentUser(user, { reset: true })
    const attachment = fileReference(modules, {
      sessionId: 'source-next',
      id: 'stable-original',
      name: 'stable.txt',
      fileName: 'stable.txt',
      bytes: new TextEncoder().encode('完整附件'),
      isImage: false,
    })
    const source = toFile(
      await buildArchive(modules, {
        sessions: [
          makeSession({ id: 'source-first' }),
          makeSession({ id: 'source-next', files: [attachment.entry] }),
        ],
        originals: [attachment.original],
      })
    )
    let unavailable = false
    const slice = source.slice.bind(source)
    source.slice = (...args) => {
      if (unavailable) throw new DOMException('源文件已丢失', 'NotFoundError')
      return slice(...args)
    }
    source.stream = () => {
      if (unavailable) throw new DOMException('源文件已丢失', 'NotFoundError')
      return Blob.prototype.stream.call(source)
    }
    const stop = modules.importProgress.useHistoryImportProgress.subscribe((state) => {
      if (state.sessions === 1) unavailable = true
    })
    try {
      assert.equal(await modules.backup.importHistory(source), 2)
      assert.equal(unavailable, true)
      assert.equal(modules.importProgress.useHistoryImportProgress.getState().files, 1)
      assert.equal(harness.importStorage.files.size, 0)
      assert.deepEqual(
        (await harness.snapshotAs(user)).sessions.map((session) => session.id).sort(),
        ['source-first', 'source-next']
      )
    } finally {
      stop()
    }
  })
})

test('源 ZIP 在准备期间读取失败，未创建云端任务且副本完整清理', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('unreadable_source')
    harness.setCurrentUser(user, { reset: true })
    const source = toFile(new Uint8Array(100))
    source.stream = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4))
        },
        pull(controller) {
          controller.error(new DOMException('源文件已丢失', 'NotFoundError'))
        },
      })
    await assert.rejects(modules.backup.importHistory(source), /无法继续读取/)
    assert.equal(harness.importStorage.files.size, 0)
    assert.equal(
      harness.requests.some((request) => request.method === 'POST'),
      false
    )
    const valid = await buildArchive(modules, { sessions: [makeSession({ id: 'readable-again' })] })
    assert.equal(await modules.backup.importHistory(toFile(valid)), 1)
  })
})

test('副本写入空间不足时保留旧历史，清理副本并准确报告原因', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('copy_quota')
    harness.setCurrentUser(user, { reset: true })
    harness.importStorage.state.beforeWrite = () => {
      throw new DOMException('空间不足', 'QuotaExceededError')
    }
    const archive = await buildArchive(modules, { sessions: [makeSession({ id: 'quota-source' })] })
    await assert.rejects(modules.backup.importHistory(toFile(archive)), /空间不足/)
    assert.equal(harness.importStorage.files.size, 0)
    assert.equal(
      harness.requests.some((request) => request.method === 'POST'),
      false
    )
    harness.importStorage.state.beforeWrite = undefined
    assert.equal(await modules.backup.importHistory(toFile(archive)), 1)
  })
})

test('副本准备期间切换账号取消读取与写入，不创建云端任务', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('copy_account')
    const other = await harness.addUser('copy_other')
    harness.setCurrentUser(user, { reset: true })
    const gate = harness.gate()
    harness.importStorage.state.beforeWrite = async () => {
      gate.markEntered()
      await gate.wait
    }
    const archive = await buildArchive(modules, { sessions: [makeSession({ id: 'copy-aborted' })] })
    const importing = modules.backup.importHistory(toFile(archive))
    await gate.entered
    harness.setCurrentUser(other, { reset: true })
    gate.release()
    await assert.rejects(importing, /abort|取消/i)
    assert.equal(harness.importStorage.files.size, 0)
    assert.equal(
      harness.requests.some((request) => request.method === 'POST'),
      false
    )
  })
})

test('导入仅恢复传输失败与临时状态，程序错误和永久失败如实报告', async () => {
  await withHarness(async (harness) => {
    const { backend, importTransport } = harness.modules
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
  })
})

test('创建响应丢失、分片连接中断及完成前断网均自动恢复同一任务', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('connection_resume')
    harness.setCurrentUser(user, { reset: true })
    const failures = new Set()
    const waits = []
    const unsubscribe = modules.importProgress.useHistoryImportProgress.subscribe((state) => {
      if (state.waiting) waits.push({ sessions: state.sessions, files: state.files })
    })
    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'resume-first' }), makeSession({ id: 'resume-next' })],
    })
    harness.intercept((request) => {
      const key =
        request.path === '/api/chats/imports'
          ? 'import-start'
          : request.path === '/api/storage/uploads'
            ? 'upload-start'
            : /\/parts\/1$/.test(request.path)
              ? 'part'
              : /\/complete$/.test(request.path)
                ? 'complete'
                : /\/commit$/.test(request.path)
                  ? 'commit'
                  : undefined
      if (!key || failures.has(key)) return
      failures.add(key)
      const failure = new TypeError('连接已中断')
      if (key.endsWith('start'))
        return {
          afterResponse() {
            throw failure
          },
        }
      return { error: failure }
    })
    try {
      assert.equal(await modules.backup.importHistory(toFile(archive)), 2)
      assert.equal(waits.length >= 5, true)
      assert.equal(harness.db.db.prepare('SELECT COUNT(*) AS n FROM cloud_imports').get().n, 1)
      assert.equal(harness.db.db.prepare('SELECT COUNT(*) AS n FROM cloud_uploads').get().n, 2)
      assert.equal(
        harness.requests.some((request) => request.method === 'DELETE'),
        false
      )
      assert.equal(harness.importStorage.files.size, 0)
      assert.equal(modules.importProgress.useHistoryImportProgress.getState().waiting, undefined)
    } finally {
      unsubscribe()
    }
  })
})

test('断网等待期间保留进度和离开提醒，联网后继续且账号变化可结束等待', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('waiting_user')
    const other = await harness.addUser('waiting_other')
    harness.setCurrentUser(user, { reset: true })
    const previousWindow = globalThis.window
    const page = new EventTarget()
    globalThis.window = page
    let disconnected = true
    harness.intercept((request) => {
      if (disconnected && request.method === 'PUT') return { error: new TypeError('连接中断') }
    })
    const archive = await buildArchive(modules, { sessions: [makeSession({ id: 'wait-resume' })] })
    try {
      const importing = modules.backup.importHistory(toFile(archive))
      await harness.waitUntil(
        () => modules.importProgress.useHistoryImportProgress.getState().waiting
      )
      const leaving = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(leaving)
      assert.equal(leaving.defaultPrevented, true)
      assert.equal(harness.files.multipartUploads.size, 1)
      disconnected = false
      page.dispatchEvent(new Event('online'))
      assert.equal(await importing, 1)
      disconnected = true
      const cancelled = modules.backup.importHistory(toFile(archive))
      await harness.waitUntil(
        () => modules.importProgress.useHistoryImportProgress.getState().waiting
      )
      harness.setCurrentUser(other, { reset: true })
      await assert.rejects(cancelled, /账号已变更|取消/)
      assert.equal(harness.importStorage.files.size, 0)
      const after = new Event('beforeunload', { cancelable: true })
      page.dispatchEvent(after)
      assert.equal(after.defaultPrevented, false)
      assert.equal(mutationRequests(harness, other).length, 0)
    } finally {
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
    }
  })
})

test('提交成功后读取列表失败明确报告已保存，不再取消已提交任务', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('committed_read_failure')
    harness.setCurrentUser(user, { reset: true })
    await modules.store.initChat()
    const archive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'saved-before-read-failure' })],
    })
    let committed = false
    harness.intercept((request) => {
      if (request.method === 'POST' && /\/imports\/[^/]+\/commit$/.test(request.path)) {
        return {
          afterResponse: () => {
            committed = true
          },
        }
      }
      if (committed && request.method === 'GET' && request.path === '/api/chats') {
        return {
          response: new Response(JSON.stringify({ error: { message: '读取更新不可用' } }), {
            status: 500,
          }),
        }
      }
    })
    await assert.rejects(
      modules.backup.importHistory(toFile(archive)),
      /历史已保存至云端，但读取更新失败/
    )
    assert.deepEqual(
      (await harness.snapshotAs(user)).sessions.map((summary) => summary.id),
      ['saved-before-read-failure']
    )
    assert.equal(
      harness.requests.some(
        (request) => request.method === 'DELETE' && /\/imports\/[^/]+$/.test(request.path)
      ),
      false
    )
  })
})

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

test('235 个会话、超过 1 MiB 的归档和超过 900 KiB 的会话逐条完整导入', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('bulk_user')
    harness.setCurrentUser(user, { reset: true })
    modules.importProgress.resetHistoryImportProgress()

    const imageBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ])
    const documentBytes = new TextEncoder().encode('%PDF-1.7\nsynthetic attachment\n')
    const image = fileReference(modules, {
      sessionId: 'bulk-0',
      id: 'image-original',
      name: 'synthetic.png',
      fileName: 'synthetic.png',
      bytes: imageBytes,
      isImage: true,
    })
    const document = fileReference(modules, {
      sessionId: 'bulk-0',
      id: 'document-original',
      name: 'synthetic.pdf',
      fileName: 'synthetic.pdf',
      bytes: documentBytes,
      isImage: false,
    })
    const largeAnswer = 'x'.repeat(1_250_000)
    const sessions = Array.from({ length: 235 }, (_, index) =>
      makeSession({
        id: `bulk-${index}`,
        title: `Synthetic session ${index}`,
        pinned: index % 10 === 0 || index === 234,
        base: 1_700_000_000_000 + index * 100_000,
        largeAnswer: index === 117 ? largeAnswer : '',
        files: index === 0 ? [image.entry, document.entry] : [],
      })
    )
    const jsonBytes = sessions.reduce(
      (total, session) => total + Buffer.byteLength(JSON.stringify(session)),
      0
    )
    const largestJson = Math.max(
      ...sessions.map((session) => Buffer.byteLength(JSON.stringify(session)))
    )
    assert.ok(jsonBytes > 1024 * 1024)
    assert.ok(largestJson > 900 * 1024)

    const archive = await buildArchive(modules, {
      sessions,
      originals: [image.original, document.original],
      originalsFirst: true,
    })
    const phases = []
    const unsubscribe = modules.importProgress.useHistoryImportProgress.subscribe((state) => {
      phases.push(state.phase)
    })
    const imported = await modules.backup.importHistory(toFile(archive))
    unsubscribe()
    assert.equal(imported, 235)
    const progress = modules.importProgress.useHistoryImportProgress.getState()
    assert.deepEqual(
      new Set(phases),
      new Set(['preparing', 'checking', 'uploading', 'committing', 'done'])
    )
    assert.equal(progress.phase, 'done')
    assert.equal(progress.sessions, 235)
    assert.equal(progress.files, 2)

    const fileTypes = new Map([
      ['image-original', 'image/png'],
      ['document-original', 'application/pdf'],
    ])
    const expected = new Map(
      sessions.map((session) => [
        session.id,
        localSession(modules, session, session.id === 'bulk-0' ? fileTypes : new Map()),
      ])
    )
    const loaded = await harness.loadAllSessionsAs(user)
    assert.equal(loaded.sessions.length, 235)
    assert.equal(loaded.generation, (await harness.snapshotAs(user)).generation)
    for (const actual of loaded.sessions) {
      assertSession(actual, expected.get(actual.id))
    }
    assert.equal(loaded.sessions.find((session) => session.id === 'bulk-234').pinned, true)

    const first = loaded.sessions.find((session) => session.id === 'bulk-0')
    const referenced = new Map(
      first.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => [file.id, file]) : []
      )
    )
    assert.equal(referenced.size, 2)
    const originals = new Map([
      ['synthetic.png', imageBytes],
      ['synthetic.pdf', documentBytes],
    ])
    for (const file of referenced.values()) {
      const response = await harness.api(user, `/api/files/${file.id}`)
      assert.equal(response.status, 200)
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), originals.get(file.name))
    }
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
    assert.deepEqual(
      modules.store.useChatStore.getState().sessions.map((session) => session.id),
      ['old-session']
    )

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
    let importUploads = 0
    harness.intercept(async (request) => {
      if (request.path !== '/api/storage/uploads' || request.method !== 'POST') {
        return
      }
      const metadata = JSON.parse(request.body)
      if (!metadata.importId || metadata.kind !== 'chat') {
        return
      }
      importUploads += 1
      if (importUploads === 2) {
        gate.markEntered()
        await gate.wait
      }
    })

    const importing = modules.backup.importHistory(toFile(archive))
    await gate.entered
    await assert.rejects(modules.backup.importHistory(toFile(archive)), /正在导入历史/)
    assert.equal(importUploads, 2)
    assert.equal(modules.store.useChatStore.getState().importingHistory, true)
    assert.deepEqual(
      modules.store.useChatStore.getState().sessions.map((session) => session.id),
      ['old-session']
    )
    const duringImport = await harness.snapshotAs(user)
    assert.deepEqual(
      duringImport.sessions.map((session) => session.id),
      ['old-session']
    )
    gate.release()
    assert.equal(await importing, 3)
    assert.deepEqual(modules.importProgress.useHistoryImportProgress.getState(), {
      phase: 'done',
      sessions: 3,
      files: 0,
    })

    const afterCommit = await harness.snapshotAs(user)
    assert.deepEqual(afterCommit.sessions.map((session) => session.id).sort(), [
      'new-alpha',
      'new-beta',
      'new-gamma',
    ])
    assert.deepEqual(
      modules.store.useChatStore
        .getState()
        .sessions.map((session) => session.id)
        .sort(),
      ['new-alpha', 'new-beta', 'new-gamma']
    )
    assert.equal(
      afterCommit.sessions.some((session) => session.id === 'old-session'),
      false
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

test('错误归档、上传数据库失败和提交失败都保留旧历史', async () => {
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

    const importStarts = () =>
      harness.requests.filter(
        (request) => request.path === '/api/chats/imports' && request.method === 'POST'
      ).length
    const beforeInvalid = importStarts()
    await assert.rejects(
      modules.backup.importHistory(
        toFile(new Uint8Array([0x4e, 0x4f, 0x54, 0x5a, 0x49, 0x50]), 'broken.zip')
      )
    )
    assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    assert.ok(modules.importProgress.useHistoryImportProgress.getState().error)
    assert.equal(importStarts(), beforeInvalid)
    assert.deepEqual((await harness.snapshotAs(user)).sessions, original.sessions)

    const validArchive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'not-published-1', title: 'Not published 1' })],
    })
    harness.db.failNext(/INSERT INTO cloud_uploads/i, new Error('injected upload insert'))
    await assert.rejects(modules.backup.importHistory(toFile(validArchive)))
    assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    assert.deepEqual((await harness.snapshotAs(user)).sessions, original.sessions)
    assert.deepEqual(
      modules.store.useChatStore.getState().sessions.map((session) => session.id),
      ['keep-old']
    )

    const commitArchive = await buildArchive(modules, {
      sessions: [makeSession({ id: 'not-published-2', title: 'Not published 2' })],
    })
    harness.db.failNext(
      /UPDATE cloud_imports\s+SET status = 'committed'/i,
      new Error('injected commit update')
    )
    await assert.rejects(modules.backup.importHistory(toFile(commitArchive)))
    assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    assert.deepEqual((await harness.snapshotAs(user)).sessions, original.sessions)
    assert.deepEqual(
      modules.store.useChatStore.getState().sessions.map((session) => session.id),
      ['keep-old']
    )
    assert.equal(
      harness.db.db
        .prepare(
          `SELECT COUNT(*) AS count FROM chats
         WHERE user_id = ? AND generation <> 'legacy'`
        )
        .get(user.id).count,
      0
    )
  })
})

test('解析后切换账号会中止上传，不向新账号写入且保留其旧会话', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const alice = await harness.addUser('identity_alice')
    const bob = await harness.addUser('identity_bob')
    const aliceOld = localSession(
      modules,
      makeSession({ id: 'alice-old', title: 'Alice old', base: 1_670_000_000_000 })
    )
    const bobOldRaw = makeSession({
      id: 'bob-old',
      title: 'Bob old',
      base: 1_671_000_000_000,
    })
    bobOldRaw.messages[0].fragments.find((fragment) => fragment.type === 'REQUEST').content =
      '**bold retained**'
    const bobOld = localSession(modules, bobOldRaw)
    await seedSession(harness, alice, aliceOld)
    await seedSession(harness, bob, bobOld)
    harness.setCurrentUser(alice, { reset: true })
    await modules.store.initChat()

    const archive = await buildArchive(modules, {
      sessions: [
        makeSession({ id: 'alice-new-1', title: 'Alice new 1' }),
        makeSession({ id: 'alice-new-2', title: 'Alice new 2' }),
      ],
    })
    const gate = harness.gate()
    let held = false
    harness.intercept(async (request) => {
      if (held || request.path !== '/api/storage/uploads' || request.method !== 'POST') {
        return
      }
      const metadata = JSON.parse(request.body)
      if (!metadata.importId) {
        return
      }
      held = true
      gate.markEntered()
      await gate.wait
    })
    const importing = modules.backup.importHistory(toFile(archive))
    await gate.entered
    harness.setCurrentUser(bob, { reset: true })
    gate.release()
    await assert.rejects(importing, /账号已变更|取消/)
    assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'error')
    assert.ok(modules.importProgress.useHistoryImportProgress.getState().error)

    assert.equal(mutationRequests(harness, bob).length, 0)
    await modules.store.initChat()
    assert.deepEqual(
      modules.store.useChatStore.getState().sessions.map((session) => session.id),
      ['bob-old']
    )
    const bobFromOtherDevice = await harness.loadSessionAs(bob, 'bob-old')
    assert.match(bobFromOtherDevice.messages[0].content, /\*\*bold retained\*\*/)
    assert.deepEqual(
      (await harness.snapshotAs(alice)).sessions.map((session) => session.id),
      ['alice-old']
    )
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
    let held = false
    harness.intercept(async (request) => {
      if (held || request.path !== '/api/storage/uploads' || request.method !== 'POST') {
        return
      }
      const metadata = JSON.parse(request.body)
      if (!metadata.importId) {
        return
      }
      held = true
      gate.markEntered()
      await gate.wait
    })
    const importing = modules.backup.importHistory(toFile(archive))
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

    const snapshot = await harness.snapshotAs(user)
    assert.deepEqual(snapshot.sessions.map((session) => session.id).sort(), [
      'concurrent-new',
      'concurrent-old',
    ])
    assertSession(await harness.loadSessionAs(user, 'concurrent-new'), concurrent)
    assert.equal(
      snapshot.sessions.some((session) => session.id === 'import-losing-race'),
      false
    )
    assert.deepEqual(
      modules.store.useChatStore.getState().sessions.map((session) => session.id),
      ['concurrent-old']
    )
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

test('完成响应丢失时查询任务状态，不重复完成上传或提交导入', async () => {
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
    assert.equal(
      harness.requests.filter(
        (request) =>
          request.method === 'POST' &&
          /^\/api\/storage\/uploads\/[^/]+\/complete$/.test(request.path)
      ).length,
      1
    )
    const uploadStatus = harness.requests.find(
      (request) => request.method === 'GET' && /^\/api\/storage\/uploads\/[^/]+$/.test(request.path)
    )
    assert.equal(uploadStatus?.status, 200)
    assert.equal(uploadStatus.body.status, 'completed')
    assert.equal(uploadStatus.body.summary.id, 'direct-upload')
    assert.equal(
      harness.requests.some(
        (request) =>
          request.method === 'DELETE' && /^\/api\/storage\/uploads\/[^/]+$/.test(request.path)
      ),
      false
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
    let lostCommit = false
    harness.intercept((request) => {
      if (
        !lostCommit &&
        request.method === 'POST' &&
        /^\/api\/chats\/imports\/[^/]+\/commit$/.test(request.path)
      ) {
        lostCommit = true
        return {
          afterResponse: () => {
            throw new Error('simulated lost commit response')
          },
        }
      }
    })
    const importing = modules.backup.importHistory(toFile(archive))
    assert.equal(await importing, 1)
    assert.deepEqual(modules.importProgress.useHistoryImportProgress.getState(), {
      phase: 'done',
      sessions: 1,
      files: 0,
    })
    assert.equal(
      harness.requests.filter(
        (request) =>
          request.method === 'POST' && /^\/api\/chats\/imports\/[^/]+\/commit$/.test(request.path)
      ).length,
      1
    )
    const importStatus = harness.requests.find(
      (request) => request.method === 'GET' && /^\/api\/chats\/imports\/[^/]+$/.test(request.path)
    )
    assert.equal(importStatus?.status, 200)
    assert.equal(importStatus.body.status, 'committed')
    assert.equal(importStatus.body.count, 1)
    assert.equal(importStatus.body.generation, (await harness.snapshotAs(user)).generation)

    const importStart = harness.requests.find(
      (request) => request.path === '/api/chats/imports' && request.method === 'POST'
    )
    assert.equal(importStart.status, 201)
    assert.equal(typeof importStart.body.id, 'string')
    assert.equal(typeof importStart.body.generation, 'string')
    assert.equal(typeof importStart.body.revision, 'number')
    const uploadStart = harness.requests.find(
      (request) => request.path === '/api/storage/uploads' && request.method === 'POST'
    )
    assert.equal(uploadStart.status, 201)
    assert.equal(typeof uploadStart.body.id, 'string')
    const part = harness.requests.find(
      (request) => request.method === 'PUT' && /\/parts\/1$/.test(request.path)
    )
    assert.equal(part.status, 200)
    assert.equal(part.body.partNumber, 1)
    assert.equal(typeof part.body.etag, 'string')
    const completedUpload = harness.requests.find(
      (request) =>
        request.method === 'POST' && /^\/api\/storage\/uploads\/[^/]+\/complete$/.test(request.path)
    )
    assert.equal(completedUpload.status, 200)
    assert.equal(completedUpload.body.summary.id, 'direct-upload')
    assert.equal(completedUpload.body.summary.pinned, false)
    const commit = harness.requests.find(
      (request) =>
        request.method === 'POST' && /^\/api\/chats\/imports\/[^/]+\/commit$/.test(request.path)
    )
    assert.equal(commit.status, 200)
    assert.equal(commit.body.count, 1)
    assert.equal(commit.body.generation, importStatus.body.generation)
    assert.equal(commit.body.revision, importStatus.body.revision)
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
      assert.equal(modules.importProgress.useHistoryImportProgress.getState().phase, 'done')
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
      const progress = modules.importProgress.useHistoryImportProgress.getState()
      assert.equal(progress.sessions, 655)
      assert.equal(progress.files, 94)
    })
  }
)
