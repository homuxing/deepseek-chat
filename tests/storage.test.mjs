import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createCloudHarness } from './helpers/cloudHarness.mjs'

const withHarness = async (run) => {
  const harness = await createCloudHarness()
  try {
    return await run(harness)
  } finally {
    await harness.dispose()
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const attachment = ({
  id,
  name = `${id}.bin`,
  size,
  isImage = false,
  mimeType = 'application/octet-stream',
  serverId = null,
}) => ({
  id,
  serverId,
  name,
  size,
  isImage,
  mimeType,
})

const makeSession = ({
  id = 'chat-1',
  title = 'initial',
  createdAt = 1_700_000_000_000,
  updatedAt = createdAt + 1,
  messages,
  files = [],
}) => ({
  id,
  title,
  createdAt,
  updatedAt,
  messages: messages ?? [
    {
      id: `${id}-message-1`,
      role: 'user',
      content: `content for ${id}`,
      files,
      createdAt,
      parentId: null,
    },
  ],
  rootMessageId: messages?.[0]?.id ?? `${id}-message-1`,
})

const storedSession = async (harness, userId, id, generation) => {
  const row = harness.db.db
    .prepare(
      `SELECT body_key
       FROM chats
       WHERE user_id = ? AND generation = ? AND id = ?`
    )
    .get(userId, generation, id)
  assert.ok(row?.body_key, `missing stored chat body for ${id}`)
  const object = await harness.files.get(row.body_key)
  assert.ok(object, `missing R2 object for ${id}`)
  return JSON.parse(await object.text())
}

const mutationRequests = (harness, user) =>
  harness.requests.filter(
    (request) =>
      request.user.id === user.id && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
  )

test('同一会话排队保存保留快照，后续重命名不会被较早上传覆盖', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('snapshot_user')
    harness.setCurrentUser(user, { reset: true })

    const fileBytes = new TextEncoder().encode('original attachment')
    const file = attachment({
      id: 'file-1',
      name: 'original.txt',
      size: fileBytes.byteLength,
      mimeType: 'text/plain',
    })
    const current = makeSession({ files: [file] })
    const gate = harness.gate()
    const observedWrites = []
    let held = false
    harness.intercept(async (request) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        observedWrites.push({
          method: request.method,
          path: request.path,
          headers: new Headers(request.headers),
        })
      }
      if (held || request.path !== '/api/storage/uploads' || request.method !== 'POST') {
        return
      }
      const metadata = JSON.parse(request.body)
      if (metadata.kind !== 'file') {
        return
      }
      held = true
      gate.markEntered()
      await gate.wait
    })

    const saving = modules.db.saveSession(current, [
      { id: file.id, blob: new Blob([fileBytes], { type: file.mimeType }) },
    ])
    current.title = 'changed only in memory'
    current.messages[0].content = 'this content must not enter the queued snapshot'
    const renaming = modules.db.renameSession(current.id, 'renamed later')

    await gate.entered
    gate.release()
    const [saved] = await Promise.all([saving, renaming])

    assert.equal(saved.id, current.id)
    assert.equal(saved.title, 'initial')
    assert.equal(saved.revision, 1)

    const row = harness.db.db
      .prepare(
        `SELECT title, revision, body_key
         FROM chats
         WHERE user_id = ? AND generation = ? AND id = ?`
      )
      .get(user.id, saved.generation, current.id)
    assert.ok(row)
    assert.equal(row.title, 'renamed later')
    assert.equal(row.revision, 2)

    const persisted = await storedSession(harness, user.id, current.id, saved.generation)
    assert.equal(persisted.title, 'initial')
    assert.equal(persisted.messages[0].content, 'content for chat-1')

    const loaded = await harness.loadSessionAs(user, current.id)
    assert.equal(loaded.title, 'renamed later')
    assert.equal(loaded.messages[0].content, 'content for chat-1')

    const writes = mutationRequests(harness, user)
    assert.deepEqual(
      writes.map((request) => request.method),
      ['POST', 'PUT', 'POST', 'POST', 'PUT', 'POST', 'PATCH']
    )
    assert.deepEqual(
      observedWrites.map((request) => request.method),
      writes.map((request) => request.method)
    )
    assert.ok(
      observedWrites.every(
        (request) =>
          request.headers.get('X-Requested-With') === 'XMLHttpRequest' &&
          request.headers.get('X-Chat-User-ID') === user.id
      ),
      JSON.stringify(
        observedWrites.map((request) => ({
          method: request.method,
          path: request.path,
          user: request.headers.get('X-Chat-User-ID'),
          requestedWith: request.headers.get('X-Requested-With'),
        }))
      )
    )
    assert.equal(observedWrites.at(-1).headers.get('X-Chat-Revision'), '1')
    assert.equal(writes.at(-1).status, 200)
    assert.equal(harness.sync.notifications.length, 2)
  })
})

test('暂存导入失败保留本地数据，重试使用新 ID 且共享附件引用', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('staging_user')
    harness.setCurrentUser(user, { reset: true })

    const oldFileId = 'existing-file-id'
    const fileBytes = new TextEncoder().encode('shared original bytes')
    const file = attachment({
      id: oldFileId,
      name: 'shared.txt',
      size: fileBytes.byteLength,
      mimeType: 'text/plain',
      serverId: 'old-upstream-id',
    })
    const current = makeSession({
      id: 'staged-chat',
      title: 'Staged chat',
      files: [file],
      messages: [
        {
          id: 'staged-message-1',
          role: 'user',
          content: 'first reference',
          files: [file],
          createdAt: 1_720_000_000_000,
          parentId: null,
        },
        {
          id: 'staged-message-2',
          role: 'user',
          content: 'second reference',
          files: [file],
          createdAt: 1_720_000_000_001,
          parentId: 'staged-message-1',
        },
      ],
    })

    await modules.db.clearStaging()
    await modules.db.addStagingSession(current)
    await modules.db.saveStagingFiles([
      { id: oldFileId, blob: new Blob([fileBytes], { type: file.mimeType }) },
    ])

    const uploads = []
    let commitAttempts = 0
    harness.intercept((request) => {
      if (request.path === '/api/storage/uploads' && request.method === 'POST') {
        uploads.push(JSON.parse(request.body))
      }
      if (
        request.method === 'POST' &&
        /^\/api\/chats\/imports\/[^/]+\/commit$/.test(request.path)
      ) {
        commitAttempts += 1
        if (commitAttempts === 1) {
          return {
            response: Response.json(
              { error: { message: 'injected commit failure' } },
              { status: 500 }
            ),
          }
        }
      }
    })

    await assert.rejects(modules.db.commitStaging(), /injected commit failure/)
    assert.equal(commitAttempts, 1)
    assert.deepEqual((await harness.snapshotAs(user)).sessions, [])
    assert.equal(current.messages[0].files[0].id, oldFileId)
    assert.equal(current.messages[0].files[0].serverId, 'old-upstream-id')

    const summaries = await modules.db.commitStaging()
    assert.equal(commitAttempts, 2)
    assert.deepEqual(
      summaries.map((summary) => summary.id),
      ['staged-chat']
    )

    const uploadByImport = new Map()
    for (const upload of uploads) {
      const entry = uploadByImport.get(upload.importId) ?? new Map()
      entry.set(upload.kind, upload)
      uploadByImport.set(upload.importId, entry)
    }
    assert.equal(uploadByImport.size, 2)
    const attempts = [...uploadByImport.values()]
    for (const attempt of attempts) {
      const chatUpload = attempt.get('chat')
      const fileUpload = attempt.get('file')
      assert.ok(chatUpload)
      assert.ok(fileUpload)
      // 上传请求只包含资源身份，正文和引用在 R2 中校验后发布。
      assert.equal(chatUpload.summary, undefined)
      assert.equal(chatUpload.files, undefined)
      assert.notEqual(fileUpload.id, oldFileId)
      assert.notEqual(fileUpload.id, 'old-upstream-id')
    }
    assert.notEqual(attempts[0].get('file').id, attempts[1].get('file').id)

    const imported = await harness.loadSessionAs(user, 'staged-chat')
    const referenced = imported.messages.flatMap((message) =>
      message.role === 'user' ? message.files : []
    )
    assert.equal(referenced.length, 2)
    assert.equal(referenced[0].id, referenced[1].id)
    assert.equal(referenced[0].id, attempts[1].get('file').id)
    assert.equal(referenced[0].serverId, null)
    assert.equal(referenced[1].serverId, null)

    const response = await harness.api(user, `/api/files/${referenced[0].id}`)
    assert.equal(response.status, 200)
    assert.equal(sha256(new Uint8Array(await response.arrayBuffer())), sha256(fileBytes))
    assert.equal(
      harness.db.db.prepare('SELECT COUNT(*) AS count FROM files WHERE user_id = ?').get(user.id)
        .count,
      1
    )
  })
})

test('单会话和附件超过旧 1 MiB 请求限制时按 multipart 完整保存', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('large_user')
    harness.setCurrentUser(user, { reset: true })

    // 235 个会话的归档导入由 importCloud.test.mjs 覆盖，这里核对单对象不再受旧请求体限制。
    const largeText = 'x'.repeat(1_100_000)
    const fileBytes = new Uint8Array(8 * 1024 * 1024 + 37)
    for (let index = 0; index < fileBytes.length; index += 1_000_003) {
      fileBytes[index] = (index / 1_000_003 + 1) % 255
    }
    fileBytes[0] = 0x89
    fileBytes[fileBytes.length - 1] = 0x7f
    const file = attachment({
      id: 'large-file',
      name: 'large.bin',
      size: fileBytes.byteLength,
      mimeType: 'application/octet-stream',
    })
    const current = makeSession({
      id: 'large-chat',
      title: 'Large session',
      messages: [
        {
          id: 'large-message',
          role: 'user',
          content: largeText,
          files: [file],
          createdAt: 1_730_000_000_000,
          parentId: null,
        },
      ],
    })

    const saved = await modules.db.saveSession(current, [
      {
        id: file.id,
        blob: new Blob([fileBytes], { type: file.mimeType }),
      },
    ])
    assert.equal(saved.revision, 1)

    const loaded = await harness.loadSessionAs(user, current.id)
    assert.equal(loaded.messages[0].content.length, largeText.length)
    assert.equal(loaded.messages[0].content, largeText)
    const response = await harness.api(user, `/api/files/${file.id}`)
    assert.equal(response.status, 200)
    assert.equal(sha256(new Uint8Array(await response.arrayBuffer())), sha256(fileBytes))

    const parts = harness.requests.filter(
      (request) =>
        request.method === 'PUT' &&
        /^\/api\/storage\/uploads\/[^/]+\/parts\/\d+$/.test(request.path)
    )
    assert.equal(parts.filter((request) => request.path.endsWith('/parts/2')).length, 1)
    assert.equal(
      harness.requests.some((request) => request.status === 413),
      false
    )
  })
})

test('身份变化取消排队写入，旧请求标头保留原账号且不写入新账号', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const alice = await harness.addUser('write_alice')
    const bob = await harness.addUser('write_bob')
    harness.setCurrentUser(alice, { reset: true })
    let identityChanges = 0
    const stopObservingIdentity = modules.backend.onBackendIdentityChange(() => {
      identityChanges += 1
    })
    try {
      modules.backend.setBackendUserId(alice.id)
      assert.equal(identityChanges, 0)

      const current = makeSession({
        files: [
          attachment({
            id: 'identity-file',
            name: 'identity.txt',
            size: 8,
            mimeType: 'text/plain',
          }),
        ],
      })
      const gate = harness.gate()
      let observed
      let held = false
      harness.intercept((request) => {
        if (held || request.path !== '/api/storage/uploads' || request.method !== 'POST') {
          return
        }
        if (JSON.parse(request.body).kind !== 'file') {
          return
        }
        held = true
        observed = {
          headers: new Headers(request.headers),
          credentials: request.init.credentials,
        }
        return {
          afterResponse: async () => {
            gate.markEntered()
            await gate.wait
          },
        }
      })

      const first = modules.db.saveSession(current, [
        {
          id: current.messages[0].files[0].id,
          blob: new Blob(['identity'], { type: 'text/plain' }),
        },
      ])
      const second = modules.db.saveSession(current)
      await gate.entered
      harness.setCurrentUser(bob, { reset: true })
      assert.equal(identityChanges, 1)
      gate.release()

      const results = await Promise.allSettled([first, second])
      assert.ok(results.every((result) => result.status === 'rejected'))
      for (const result of results) {
        assert.equal(result.reason.status, 409)
      }

      assert.equal(observed.credentials, 'same-origin')
      assert.equal(observed.headers.get('X-Chat-User-ID'), alice.id)
      assert.equal(observed.headers.get('X-Requested-With'), 'XMLHttpRequest')
      assert.equal(mutationRequests(harness, bob).length, 0)
      assert.deepEqual(
        mutationRequests(harness, alice).map((request) => request.path),
        ['/api/storage/uploads']
      )
      assert.equal(
        harness.requests.some(
          (request) =>
            request.method === 'DELETE' && /^\/api\/storage\/uploads\/[^/]+$/.test(request.path)
        ),
        false
      )
    } finally {
      stopObservingIdentity()
    }
  })
})

test('同一会话使用过期 revision 保存返回 409，不会静默改用最新版本', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('revision_user')
    harness.setCurrentUser(user, { reset: true })

    const initial = makeSession({
      id: 'versioned-chat',
      title: 'Initial',
      createdAt: 1_740_000_000_000,
    })
    const first = await modules.db.saveSession(initial)
    assert.equal(first.revision, 1)

    const otherDevice = structuredClone(initial)
    otherDevice.title = 'Other device update'
    otherDevice.updatedAt += 1
    const other = await harness.saveSessionAs(user, otherDevice, {
      expectedRevision: first.revision,
    })
    assert.equal(other.complete.status, 200)

    const metadata = []
    harness.intercept((request) => {
      if (request.path === '/api/storage/uploads' && request.method === 'POST') {
        const value = JSON.parse(request.body)
        if (value.kind === 'chat') {
          metadata.push(value)
        }
      }
    })

    const stale = structuredClone(initial)
    stale.title = 'Stale local update'
    stale.updatedAt += 2
    stale.revision = first.revision
    stale.generation = first.generation
    const error = await modules.db.saveSession(stale).catch((reason) => reason)

    assert.ok(error instanceof Error)
    assert.equal(error.status, 409)
    assert.match(error.message, /其他设备|版本|重新加载/)
    assert.equal(metadata.length, 1)
    assert.equal(metadata[0].expectedRevision, first.revision)
    assert.equal(metadata[0].generation, first.generation)

    assert.equal((await harness.loadSessionAs(user, initial.id)).title, 'Other device update')
    const conflicts = harness.requests.filter(
      (request) =>
        request.method === 'POST' &&
        /^\/api\/storage\/uploads\/[^/]+\/complete$/.test(request.path) &&
        request.status === 409
    )
    assert.equal(conflicts.length, 1)
  })
})

test('新附件分片上传完成后等待会话发布，最终正文和文件字节都保留', async () => {
  await withHarness(async (harness) => {
    const { modules } = harness
    const user = await harness.addUser('file_session_user')
    harness.setCurrentUser(user, { reset: true })

    const fileBytes = new TextEncoder().encode('new file bytes survive publication')
    const file = attachment({
      id: 'new-file',
      name: 'new-file.txt',
      size: fileBytes.byteLength,
      mimeType: 'text/plain',
    })
    const current = makeSession({
      id: 'file-chat',
      title: 'File chat',
      files: [file],
    })

    const uploadKinds = new Map()
    const gate = harness.gate()
    let held = false
    harness.intercept(async (request) => {
      if (request.path === '/api/storage/uploads' && request.method === 'POST') {
        const metadata = JSON.parse(request.body)
        return {
          afterResponse: async (response) => {
            const started = await response.clone().json()
            uploadKinds.set(started.id, metadata.kind)
          },
        }
      }
      const match = /^\/api\/storage\/uploads\/([^/]+)\/complete$/.exec(request.path)
      if (match && !held && request.method === 'POST' && uploadKinds.get(match[1]) === 'chat') {
        held = true
        gate.markEntered()
        await gate.wait
      }
    })

    const saving = modules.db.saveSession(current, [
      {
        id: file.id,
        blob: new Blob([fileBytes], { type: file.mimeType }),
      },
    ])
    await gate.entered

    const fileRow = harness.db.db
      .prepare(
        `SELECT r2_key, mime_type, size
         FROM files
         WHERE user_id = ? AND id = ?`
      )
      .get(user.id, file.id)
    assert.ok(fileRow)
    assert.equal(fileRow.size, fileBytes.byteLength)
    assert.equal(fileRow.mime_type, file.mimeType)
    const beforePublish = await harness.files.get(fileRow.r2_key)
    assert.ok(beforePublish)
    assert.equal(sha256(new Uint8Array(await beforePublish.arrayBuffer())), sha256(fileBytes))
    assert.equal(
      harness.db.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM chats
           WHERE user_id = ? AND id = ?`
        )
        .get(user.id, current.id).count,
      0
    )

    gate.release()
    const saved = await saving
    const loaded = await harness.loadSessionAs(user, current.id)
    assert.equal(loaded.title, current.title)
    assert.equal(loaded.messages[0].files[0].id, file.id)
    assert.equal(loaded.messages[0].files[0].serverId, null)
    assert.equal(saved.revision, 1)
    assert.deepEqual(
      harness.db.db
        .prepare(
          `SELECT file_id
           FROM chat_files
           WHERE user_id = ? AND generation = ? AND chat_id = ?`
        )
        .all(user.id, saved.generation, current.id)
        .map((row) => row.file_id),
      [file.id]
    )

    assert.ok(await harness.files.get(fileRow.r2_key))
    const response = await harness.api(user, `/api/files/${file.id}`)
    assert.equal(response.status, 200)
    assert.equal(sha256(new Uint8Array(await response.arrayBuffer())), sha256(fileBytes))
  })
})
