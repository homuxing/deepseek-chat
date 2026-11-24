import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCloudHarness } from './helpers/cloudHarness.mjs'

const BASE = 1_700_000_000_000

const withHarness = async (run) => {
  const harness = await createCloudHarness()
  try {
    return await run(harness)
  } finally {
    await harness.dispose()
  }
}

const localSession = ({
  id,
  title,
  updatedAt = BASE,
  pinned = false,
  messages,
}) => ({
  id,
  title,
  createdAt: BASE,
  updatedAt,
  pinned,
  messages: messages ?? [
    {
      id: `${id}-user`,
      role: 'user',
      content: `Question for ${id}`,
      files: [],
      createdAt: BASE,
      parentId: null,
    },
    {
      id: `${id}-assistant`,
      role: 'assistant',
      createdAt: BASE + 1,
      model: 'deepseek-flash',
      thinking: false,
      search: false,
      prefix: true,
      status: 'done',
      blocks: [{ type: 'text', text: `Answer for ${id}` }],
      parentId: `${id}-user`,
    },
  ],
  rootMessageId: `${id}-user`,
})

const seedSession = async (harness, session) => harness.modules.db.saveSession(session)

const waitForLoaded = async (harness, id) => {
  await harness.waitUntil(
    () => Boolean(harness.modules.store.useChatStore.getState().sessionCache[id])
  )
}

const setupConflict = async (harness, {
  sessionId = 'conflict-session',
  title = 'Pinned original',
} = {}) => {
  const user = await harness.addUser(`conflict_${sessionId}`)
  harness.setCurrentUser(user, { reset: true })
  const original = localSession({
    id: sessionId,
    title,
    updatedAt: BASE + 10,
    pinned: true,
  })
  const originalSummary = await seedSession(harness, original)
  const unpinned = localSession({
    id: `${sessionId}-newer`,
    title: 'Newer unpinned',
    updatedAt: BASE + 20,
  })
  await seedSession(harness, unpinned)

  await harness.modules.store.initChat()
  harness.modules.store.selectSession(sessionId)
  await waitForLoaded(harness, sessionId)

  const cloudLatest = structuredClone(original)
  cloudLatest.title = 'Cloud latest'
  cloudLatest.updatedAt = BASE + 30
  cloudLatest.messages.push({
    id: `${sessionId}-cloud-user`,
    role: 'user',
    content: 'Cloud device edit',
    files: [],
    createdAt: BASE + 31,
    parentId: original.messages.at(-1).id,
  })
  const cloudResult = await harness.saveSessionAs(user, cloudLatest, {
    expectedRevision: originalSummary.revision,
  })
  assert.equal(cloudResult.complete.status, 200)

  const pendingFile = {
    id: `${sessionId}-local-file`,
    serverId: null,
    name: 'local-note.txt',
    size: 17,
    isImage: false,
    mimeType: 'text/plain',
  }
  const localState = harness.modules.store.useChatStore.getState()
  const local = structuredClone(localState.sessionCache[sessionId])
  local.title = 'Local pending title'
  local.updatedAt = BASE + 40
  local.messages.push({
    id: `${sessionId}-local-user`,
    role: 'user',
    content: 'Local unsaved edit',
    files: [pendingFile],
    createdAt: BASE + 41,
    parentId: local.messages.at(-1).id,
  })
  local.messages.push({
    id: `${sessionId}-local-assistant`,
    role: 'assistant',
    createdAt: BASE + 42,
    model: 'deepseek-flash',
    thinking: false,
    search: false,
    prefix: true,
    status: 'stopped',
    blocks: [{ type: 'text', text: 'Local unsaved answer' }],
    parentId: `${sessionId}-local-user`,
  })
  local.messages.push({
    id: `${sessionId}-local-assistant-alt`,
    role: 'assistant',
    createdAt: BASE + 43,
    model: 'deepseek-flash',
    thinking: false,
    search: false,
    prefix: true,
    status: 'done',
    blocks: [{ type: 'text', text: 'Alternate local answer' }],
    parentId: `${sessionId}-local-user`,
  })
  local.messages.find(
    (message) => message.id === `${sessionId}-local-user`
  ).selectedChildId = `${sessionId}-local-assistant`
  harness.modules.store.useChatStore.setState((state) => ({
    sessionCache: { ...state.sessionCache, [sessionId]: local },
    sessions: state.sessions.map((summary) =>
      summary.id === sessionId
        ? { ...summary, title: local.title, updatedAt: local.updatedAt }
        : summary
    ),
  }))
  harness.modules.store.renameSession(sessionId, local.title)
  await harness.waitUntil(
    () => harness.modules.store.useChatStore.getState().sessionConflictErrors[sessionId] === true
  )
  await harness.modules.db.waitForStorageWrites()

  return { user, original, originalSummary, cloudLatest, local, pendingFile }
}

const completeConflicts = (harness) =>
  harness.requests.filter(
    (request) =>
      request.method === 'POST' &&
      /^\/api\/storage\/uploads\/[^/]+\/complete$/.test(request.path) &&
      request.status === 409
  ).length

const setupVersionedLoad = async (harness, id) => {
  const user = await harness.addUser(`load_${id}`)
  harness.setCurrentUser(user, { reset: true })
  const first = localSession({
    id,
    title: 'Cloud revision one',
    updatedAt: BASE + 200,
  })
  const firstSummary = await seedSession(harness, first)
  await harness.modules.store.initChat()
  const second = structuredClone(first)
  second.title = 'Cloud revision two'
  second.updatedAt = BASE + 201
  second.messages.push({
    id: `${id}-cloud-second`,
    role: 'user',
    content: 'Second device content',
    files: [],
    createdAt: BASE + 202,
    parentId: first.messages.at(-1).id,
  })
  return { user, first, firstSummary, second }
}

const oldSessionResponse = (session, summary) => ({
  response: new Response(JSON.stringify({ session, summary }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
})

test('冲突后停止重复写入，副本保存完再载入云端最新版本并保留本地消息与附件', async () => {
  await withHarness(async (harness) => {
    const originalError = console.error
    console.error = () => {}
    try {
      const { modules } = harness
      const { user, pendingFile } = await setupConflict(harness)
      const id = 'conflict-session'

      assert.equal(completeConflicts(harness), 1)
      modules.store.retrySaveSessions()
      await modules.store.renameSession(id, 'Another local title')
      await modules.db.waitForStorageWrites()
      assert.equal(completeConflicts(harness), 1)
      assert.equal(
        modules.store.useChatStore.getState().sessionCache[id].title,
        'Another local title'
      )
      assert.equal((await harness.loadSessionAs(user, id)).title, 'Cloud latest')

      assert.equal(await modules.store.resolveSessionConflict(id), true)
      await modules.db.waitForStorageWrites()

      const snapshot = await harness.loadAllSessionsAs(user)
      assert.equal(snapshot.sessions.length, 3)
      const copy = snapshot.sessions.find(
        (session) => session.id !== id && session.id !== `${id}-newer`
      )
      assert.ok(copy)
      assert.match(copy.title, /Another local title/)
      assert.equal(copy.pinned, true)
      assert.equal(
        copy.messages.some((message) => message.content === 'Local unsaved edit'),
        true
      )
      assert.equal(
        copy.messages
          .flatMap((message) => (message.role === 'user' ? message.files : []))
          .some((file) => file.id === pendingFile.id && file.name === pendingFile.name),
        true
      )

      const latest = await harness.loadSessionAs(user, id)
      assert.equal(latest.title, 'Cloud latest')
      assert.equal(
        latest.messages.some((message) => message.content === 'Cloud device edit'),
        true
      )
      const summaries = (await harness.snapshotAs(user)).sessions
      const originalSummary = summaries.find((summary) => summary.id === id)

      const state = modules.store.useChatStore.getState()
      assert.equal(state.sessionConflictErrors[id], undefined)
      assert.equal(state.sessionSaveErrors[id], undefined)
      assert.equal(state.sessionCache[id].title, 'Cloud latest')
      assert.equal(state.sessionCache[id].revision, originalSummary.revision)
      assert.ok(state.sessions.some((summary) => summary.id === copy.id))
      const pinned = state.sessions.filter((summary) => summary.pinned)
      assert.equal(pinned.length, 2)
      assert.deepEqual(
        state.sessions.slice(-1).map((summary) => summary.id),
        [`${id}-newer`]
      )
    } finally {
      console.error = originalError
    }
  })
})

test('目录升到新 revision 时旧 pending load 被新版本任务替换，晚到响应不写缓存', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const id = 'late-load-sync'
    const { user, first, firstSummary, second } = await setupVersionedLoad(harness, id)
    const gate = harness.gate()
    let sessionGets = 0
    let oldReturned = false
    const remove = harness.intercept(async (request) => {
      if (request.method !== 'GET' || request.path !== `/api/chats/${id}`) {
        return
      }
      sessionGets += 1
      if (sessionGets !== 1) {
        return
      }
      gate.markEntered()
      await gate.wait
      oldReturned = true
      return oldSessionResponse(first, firstSummary)
    })
    const loadedRevisions = []
    const unsubscribe = modules.store.useChatStore.subscribe((state) => {
      const session = state.sessionCache[id]
      if (session) {
        loadedRevisions.push(session.revision)
      }
    })
    try {
      modules.store.selectSession(id)
      await gate.entered
      const saved = await harness.saveSessionAs(user, second, {
        expectedRevision: firstSummary.revision,
      })
      assert.equal(saved.complete.status, 200)
      await modules.store.synchronizeHistory()
      const current = modules.store.useChatStore.getState().sessionCache[id]
      assert.equal(current.revision, saved.completed.summary.revision)
      assert.equal(current.title, 'Cloud revision two')

      gate.release()
      await harness.waitUntil(() => oldReturned)
      await harness.waitUntil(() => sessionGets === 2)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const state = modules.store.useChatStore.getState()
      assert.equal(state.sessionCache[id].revision, saved.completed.summary.revision)
      assert.equal(state.sessionCache[id].title, 'Cloud revision two')
      assert.ok(
        loadedRevisions.every((revision) => revision === saved.completed.summary.revision),
        JSON.stringify(loadedRevisions)
      )
    } finally {
      gate.release()
      remove()
      unsubscribe()
    }
  })
})

test('正文响应落后当前目录时丢弃旧 cache，并立即重读目录中的新版本', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const id = 'late-load-reread'
    const { user, first, firstSummary, second } = await setupVersionedLoad(harness, id)
    const gate = harness.gate()
    let sessionGets = 0
    let oldReturned = false
    const remove = harness.intercept(async (request) => {
      if (request.method !== 'GET' || request.path !== `/api/chats/${id}`) {
        return
      }
      sessionGets += 1
      if (sessionGets !== 1) {
        return
      }
      gate.markEntered()
      await gate.wait
      oldReturned = true
      return oldSessionResponse(first, firstSummary)
    })
    const loadedRevisions = []
    const unsubscribe = modules.store.useChatStore.subscribe((state) => {
      const session = state.sessionCache[id]
      if (session) {
        loadedRevisions.push(session.revision)
      }
    })
    try {
      modules.store.selectSession(id)
      await gate.entered
      const saved = await harness.saveSessionAs(user, second, {
        expectedRevision: firstSummary.revision,
      })
      assert.equal(saved.complete.status, 200)
      const latestSummary = (await harness.snapshotAs(user)).sessions.find(
        (summary) => summary.id === id
      )
      assert.ok(latestSummary)
      modules.store.useChatStore.setState((state) => ({
        sessions: state.sessions.map((summary) =>
          summary.id === id ? { ...summary, ...latestSummary } : summary
        ),
        sessionCache: Object.fromEntries(
          Object.entries(state.sessionCache).filter(([sessionId]) => sessionId !== id)
        ),
      }))

      gate.release()
      await harness.waitUntil(() => oldReturned)
      await harness.waitUntil(() => sessionGets === 2)
      await harness.waitUntil(
        () =>
          modules.store.useChatStore.getState().sessionCache[id]?.revision ===
          latestSummary.revision
      )
      const state = modules.store.useChatStore.getState()
      assert.equal(state.sessionCache[id].title, 'Cloud revision two')
      assert.equal(state.sessionLoadErrors[id], false)
      assert.ok(
        loadedRevisions.every((revision) => revision === latestSummary.revision),
        JSON.stringify(loadedRevisions)
      )
    } finally {
      gate.release()
      remove()
      unsubscribe()
    }
  })
})

test('副本写入失败时保留冲突和本地内容，重试成功后只创建一份副本', async () => {
  await withHarness(async (harness) => {
    const originalError = console.error
    console.error = () => {}
    try {
      const { modules } = harness
      const { user } = await setupConflict(harness, { sessionId: 'retry-conflict' })
      const id = 'retry-conflict'
      let failed = false
      const remove = harness.intercept((request) => {
        if (failed || request.method !== 'POST' || request.path !== '/api/storage/uploads') {
          return
        }
        const metadata = JSON.parse(request.body)
        if (metadata.kind !== 'chat') {
          return
        }
        failed = true
        return {
          response: new Response(
            JSON.stringify({ error: { message: 'forced copy failure' } }),
            { status: 500, headers: { 'content-type': 'application/json' } }
          ),
        }
      })
      try {
        assert.equal(await modules.store.resolveSessionConflict(id), false)
        assert.equal(failed, true)
        assert.equal(
          modules.store.useChatStore.getState().sessionConflictErrors[id],
          true
        )
        assert.equal(modules.store.useChatStore.getState().sessionCache[id].title, 'Local pending title')
        assert.equal(modules.store.useChatStore.getState().syncErrorKind, 'action')
        assert.match(modules.store.useChatStore.getState().syncError, /forced copy failure/)
        assert.equal((await harness.loadAllSessionsAs(user)).sessions.length, 2)
      } finally {
        remove()
      }

      assert.equal(await modules.store.resolveSessionConflict(id), true)
      const snapshot = await harness.loadAllSessionsAs(user)
      assert.equal(snapshot.sessions.length, 3)
      const copies = snapshot.sessions.filter(
        (session) => session.id !== id && session.id !== `${id}-newer`
      )
      assert.equal(copies.length, 1)
      assert.equal(
        copies[0].messages.some((message) => message.content === 'Local unsaved edit'),
        true
      )
    } finally {
      console.error = originalError
    }
  })
})

test('冲突处理期间 store 拒绝同会话编辑、分支和发送，并阻止历史替换清空冲突', async () => {
  await withHarness(async (harness) => {
    const originalError = console.error
    console.error = () => {}
    try {
      const { modules } = harness
      await setupConflict(harness, { sessionId: 'locked-conflict' })
      const id = 'locked-conflict'
      const gate = harness.gate()
      const remove = harness.intercept(async (request) => {
        if (request.method !== 'POST' || request.path !== '/api/storage/uploads') {
          return
        }
        const metadata = JSON.parse(request.body)
        if (metadata.kind !== 'chat') {
          return
        }
        gate.markEntered()
        await gate.wait
      })
      const resolving = modules.store.resolveSessionConflict(id)
      try {
        await gate.entered
        const before = structuredClone(
          modules.store.useChatStore.getState().sessionCache[id]
        )
        await modules.store.renameSession(id, 'Rename during resolve')
        assert.equal(
          modules.store.editMessage(id, `${id}-local-user`, 'Edit during resolve'),
          false
        )
        modules.store.regenerateReply(id, `${id}-local-assistant`)
        modules.store.selectMessageVersion(id, `${id}-local-assistant-alt`)
        modules.store.continueReply(id, `${id}-local-assistant`)
        modules.store.retryUpload(id, `${id}-local-assistant`)
        assert.equal(modules.store.sendMessage(id), false)
        assert.deepEqual(
          modules.store.useChatStore.getState().sessionCache[id],
          before
        )

        let writeCalled = false
        await assert.rejects(
          modules.store.replaceHistory(async () => {
            writeCalled = true
            return []
          }),
          /冲突/
        )
        assert.equal(writeCalled, false)
        assert.equal(modules.store.useChatStore.getState().importingHistory, false)
        assert.equal(
          modules.store.useChatStore.getState().sessionConflictErrors[id],
          true
        )
      } finally {
        gate.release()
        remove()
      }
      assert.equal(await resolving, true)
      const state = modules.store.useChatStore.getState()
      assert.equal(state.sessionConflictErrors[id], undefined)
      assert.equal(state.sessionCache[id].title, 'Cloud latest')
    } finally {
      console.error = originalError
    }
  })
})

test('处理冲突期间切换账号会取消副本写入，不把本地内容写到新账号', async () => {
  await withHarness(async (harness) => {
    const originalError = console.error
    console.error = () => {}
    try {
      const { modules } = harness
      const { user } = await setupConflict(harness, { sessionId: 'identity-conflict' })
      const id = 'identity-conflict'
      const otherUser = await harness.addUser('conflict_other_account')
      const gate = harness.gate()
      const remove = harness.intercept(async (request) => {
        if (request.method !== 'POST' || request.path !== '/api/storage/uploads') {
          return
        }
        const metadata = JSON.parse(request.body)
        if (metadata.kind !== 'chat') {
          return
        }
        gate.markEntered()
        await gate.wait
      })
      try {
        const resolving = modules.store.resolveSessionConflict(id)
        await gate.entered
        harness.setCurrentUser(otherUser, { reset: true })
        gate.release()
        assert.equal(await resolving, false)
        assert.equal((await harness.loadAllSessionsAs(user)).sessions.length, 2)
        assert.equal((await harness.loadAllSessionsAs(otherUser)).sessions.length, 0)
        assert.equal(modules.store.useChatStore.getState().sessions.length, 0)
      } finally {
        remove()
      }
    } finally {
      console.error = originalError
    }
  })
})

test('未加载会话重命名成功后更新目录 revision，冲突失败时保持旧标题并显式报告', async () => {
  await withHarness(async (harness) => {
    const originalError = console.error
    console.error = () => {}
    try {
      const { modules } = harness
      const user = await harness.addUser('rename_directory')
      harness.setCurrentUser(user, { reset: true })
      const session = localSession({
        id: 'rename-session',
        title: 'Original title',
        updatedAt: BASE + 100,
      })
      const saved = await seedSession(harness, session)
      await modules.store.initChat()
      assert.equal(
        modules.store.useChatStore.getState().sessionCache['rename-session'],
        undefined
      )

      await modules.store.renameSession('rename-session', 'First rename')
      let summary = modules.store
        .useChatStore.getState()
        .sessions.find((item) => item.id === 'rename-session')
      assert.equal(summary.title, 'First rename')
      assert.ok(summary.revision > saved.revision)
      assert.equal((await harness.loadSessionAs(user, 'rename-session')).title, 'First rename')

      const otherDevice = await harness.loadSessionAs(user, 'rename-session')
      otherDevice.title = 'Other device title'
      otherDevice.updatedAt += 1
      const other = await harness.saveSessionAs(user, otherDevice, {
        expectedRevision: summary.revision,
      })
      assert.equal(other.complete.status, 200)

      await modules.store.renameSession('rename-session', 'Stale rename')
      const state = modules.store.useChatStore.getState()
      summary = state.sessions.find((item) => item.id === 'rename-session')
      assert.equal(summary.title, 'First rename')
      assert.equal(summary.revision, saved.revision + 1)
      assert.equal(state.syncErrorKind, 'action')
      assert.match(state.syncError, /其他设备|版本|更新/)
      assert.equal((await harness.loadSessionAs(user, 'rename-session')).title, 'Other device title')
    } finally {
      console.error = originalError
    }
  })
})
