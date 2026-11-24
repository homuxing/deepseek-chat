import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { createCloudHarness, LocalD1, LocalR2 } from './helpers/cloudHarness.mjs'

const withHarness = async (run) => {
  const harness = await createCloudHarness()
  try {
    return await run(harness)
  } finally {
    await harness.dispose()
  }
}

const chat = (id, title, updatedAt = Date.now()) => ({
  id,
  title,
  createdAt: updatedAt - 10,
  updatedAt,
  pinned: false,
  messages: [],
})

test('不同会话并发保存互不冲突，同一会话只有一个 revision 写入成功', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('parallel_saves')

    const independent = await Promise.all([
      harness.saveSessionAs(user, chat('parallel-a', 'A')),
      harness.saveSessionAs(user, chat('parallel-b', 'B')),
    ])
    assert.deepEqual(independent.map((result) => result.complete.status), [200, 200])
    const initial = await harness.snapshotAs(user)
    assert.deepEqual(initial.sessions.map((summary) => summary.id).sort(), ['parallel-a', 'parallel-b'])

    const savedA = initial.sessions.find((summary) => summary.id === 'parallel-a')
    const first = chat('parallel-a', 'winner', Date.now() + 10)
    const second = chat('parallel-a', 'loser', Date.now() + 11)
    const results = await Promise.all([
      harness.saveSessionAs(user, first, { expectedRevision: savedA.revision }),
      harness.saveSessionAs(user, second, { expectedRevision: savedA.revision }),
    ])
    assert.deepEqual(results.map((result) => result.complete.status).sort(), [200, 409])
    assert.match(await harness.loadSessionAs(user, 'parallel-a').then((value) => value.title), /winner|loser/)

    const after = await harness.snapshotAs(user)
    assert.ok(after.revision > initial.revision)
    assert.equal(new Set(after.sessions.map((summary) => summary.generation)).size, 1)
  })
})

test('先完成的附件保留到会话提交，9 MiB 文件使用两个 multipart 分片', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('retained_original')
    const beforeNotifications = harness.sync.notifications.length
    const original = new Uint8Array(8 * 1024 * 1024 + 123)
    original[0] = 0x89
    original[original.length - 1] = 0x42

    const started = await harness.api(user, '/api/storage/uploads', {
      method: 'POST',
      body: { kind: 'file', id: 'retained-file', mimeType: 'image/png' },
    })
    assert.equal(started.status, 201)
    const uploadPath = `/api/storage/uploads/${(await started.json()).id}`
    const partStatuses = []
    for (let part = 1; part <= 2; part++) {
      const response = await harness.api(user, `${uploadPath}/parts/${part}`, {
        method: 'PUT',
        body: new Blob([original.slice((part - 1) * 8 * 1024 * 1024, part * 8 * 1024 * 1024)]),
      })
      partStatuses.push(response.status)
    }
    assert.deepEqual(partStatuses, [200, 200])
    const completed = await harness.api(user, `${uploadPath}/complete`, {
      method: 'POST',
      body: { parts: 2 },
    })
    assert.equal(completed.status, 200)
    assert.equal(harness.sync.notifications.length, beforeNotifications)
    assert.deepEqual((await harness.snapshotAs(user)).sessions, [])

    const session = {
      ...chat('with-retained-file', 'Retained file', 1_700_000_000_000),
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: '',
          createdAt: 1_700_000_000_001,
          files: [
            {
              id: 'retained-file',
              serverId: null,
              name: 'large.png',
              size: original.byteLength,
              isImage: true,
              mimeType: '',
            },
          ],
        },
      ],
    }
    const saved = await harness.saveSessionAs(user, session)
    assert.equal(saved.complete.status, 200)
    const loaded = await harness.loadSessionAs(user, session.id)
    assert.equal(loaded.messages[0].files[0].mimeType, 'image/png')
    const downloaded = await harness.api(user, '/api/files/retained-file')
    assert.equal(downloaded.status, 200)
    const bytes = new Uint8Array(await downloaded.arrayBuffer())
    assert.equal(bytes.byteLength, original.byteLength)
    assert.equal(bytes[0], 0x89)
    assert.equal(bytes.at(-1), 0x42)
  })
})

test('详情读取遇到导入切换与旧正文清理时读取当前 generation', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('read_generation')
    await harness.saveSessionAs(user, chat('shared-chat', '旧会话'))
    const old = harness.db.db.prepare(
      'SELECT body_key FROM chats WHERE user_id = ? AND id = ?'
    ).get(user.id, 'shared-chat')
    const imported = await harness.createImport(user)
    const saved = await harness.uploadBlobAs(
      user,
      {
        kind: 'chat',
        id: 'shared-chat',
        importId: imported.id,
        generation: imported.generation,
        expectedRevision: imported.revision,
      },
      new Blob([JSON.stringify(chat('shared-chat', '新会话'))], {
        type: 'application/json',
      })
    )
    assert.equal(saved.complete.status, 200)

    const originalGet = harness.files.get.bind(harness.files)
    let switched = false
    harness.files.get = async (key) => {
      if (!switched && key === old.body_key) {
        switched = true
        harness.db.db.prepare(
          'UPDATE cloud_history SET generation = ?, revision = revision + 1 WHERE user_id = ?'
        ).run(imported.generation, user.id)
        harness.db.db.prepare(
          'DELETE FROM chats WHERE user_id = ? AND generation != ?'
        ).run(user.id, imported.generation)
        await harness.files.delete(key)
      }
      return originalGet(key)
    }

    const loaded = await harness.loadSessionAs(user, 'shared-chat')
    assert.equal(switched, true)
    assert.equal(loaded.title, '新会话')
  })
})

test('cleanupAbandonedStorage 可独立调用并取消过期的导入与 multipart 任务', async () => {
  mkdirSync('test-results', { recursive: true })
  const output = 'test-results/cloudStorageModule.mjs'
  await build({
    stdin: {
      contents: "export * from './server/cloudStorage.ts'",
      resolveDir: process.cwd(),
      sourcefile: 'cloud-storage-test-entry.ts',
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
  })
  const { cleanupAbandonedStorage } = await import(`../${output}?${Date.now()}`)
  const db = new LocalD1()
  const files = new LocalR2()
  const now = Date.now()
  const old = now - 25 * 60 * 60 * 1000
  db.db.prepare(
    `INSERT INTO users
       (id, username, password_hash, role, status, created_at, auth_version)
     VALUES ('cleanup-user', 'cleanup_user', NULL, 'user', 'active', ?, 1)`
  ).run(now)
  db.db.prepare(
    `INSERT INTO cloud_history (user_id, generation, revision)
     VALUES ('cleanup-user', 'legacy', 1)`
  ).run()
  db.db.prepare(
    `INSERT INTO cloud_imports
       (user_id, id, generation, base_revision, status, count, created_at, updated_at)
     VALUES ('cleanup-user', 'stale-import', 'import_stale', 1, 'staging', 0, ?, ?)`
  ).run(old, old)
  const multipart = await files.createMultipartUpload('cleanup-user/uploads/stale', {})
  db.db.prepare(
    `INSERT INTO cloud_uploads
       (user_id, id, kind, object_id, generation, r2_key, multipart_id,
        mime_type, status, created_at, updated_at)
     VALUES ('cleanup-user', 'stale-upload', 'file', 'stale-file', 'legacy',
             'cleanup-user/uploads/stale', ?, 'text/plain', 'uploading', ?, ?)`
  ).run(multipart.uploadId, old, old)

  try {
    await cleanupAbandonedStorage({
      DB: db,
      FILES: files,
    })
    assert.equal(
      db.db.prepare("SELECT status FROM cloud_imports WHERE id = 'stale-import'").get().status,
      'cancelled'
    )
    assert.equal(
      db.db.prepare("SELECT status FROM cloud_uploads WHERE id = 'stale-upload'").get().status,
      'cancelled'
    )
    assert.equal(files.multipartUploads.has(multipart.uploadId), false)
  } finally {
    db.close()
  }
})

test('上传完成与取消失败互斥，发布后的对象不会被取消请求删除', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('cancel_race')
    const started = await harness.api(user, '/api/storage/uploads', {
      method: 'POST',
      body: { kind: 'file', id: 'race-file', mimeType: 'text/plain' },
    })
    assert.equal(started.status, 201)
    const uploadPath = `/api/storage/uploads/${(await started.json()).id}`
    const part = await harness.api(user, `${uploadPath}/parts/1`, {
      method: 'PUT',
      body: new Blob(['published bytes']),
    })
    assert.equal(part.status, 200)

    const [completed, cancelled] = await Promise.all([
      harness.api(user, `${uploadPath}/complete`, {
        method: 'POST',
        body: { parts: 1 },
      }),
      harness.api(user, uploadPath, { method: 'DELETE' }),
    ])
    assert.ok(
      (completed.status === 200 && cancelled.status === 409) ||
        (completed.status === 409 && cancelled.status === 204),
      `unexpected completion/cancel statuses: ${completed.status}/${cancelled.status}`
    )
    const status = await (await harness.api(user, uploadPath)).json()
    if (status.status === 'completed') {
      const downloaded = await harness.api(user, '/api/files/race-file')
      assert.equal(downloaded.status, 200)
      assert.equal(await downloaded.text(), 'published bytes')
    } else {
      assert.equal(status.status, 'cancelled')
      assert.equal((await harness.api(user, '/api/files/race-file')).status, 404)
    }
  })
})

test('cleanupExpiredGenerations 在删除时读取当前指针，不误删刚提交的新 generation', async () => {
  mkdirSync('test-results', { recursive: true })
  const output = 'test-results/cloudStorageGenerationModule.mjs'
  await build({
    stdin: {
      contents: "export * from './server/cloudStorage.ts'",
      resolveDir: process.cwd(),
      sourcefile: 'cloud-storage-generation-test-entry.ts',
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
  })
  const { cleanupExpiredGenerations } = await import(`../${output}?${Date.now()}`)
  const db = new LocalD1()
  const files = new LocalR2()
  const now = Date.now()
  db.db.prepare(
    `INSERT INTO users
       (id, username, password_hash, role, status, created_at, auth_version)
     VALUES ('generation-user', 'generation_user', NULL, 'user', 'active', ?, 1)`
  ).run(now)
  db.db.prepare(
    `INSERT INTO cloud_history (user_id, generation, revision)
     VALUES ('generation-user', 'legacy', 1)`
  ).run()
  for (const [generation, id, key] of [
    ['legacy', 'old-chat', 'generation-user/chats/legacy/old'],
    ['import_new', 'new-chat', 'generation-user/chats/import_new/new'],
  ]) {
    await files.put(key, JSON.stringify({ id, title: id, createdAt: 1, updatedAt: 2, messages: [] }))
    db.db.prepare(
      `INSERT INTO chats
         (user_id, generation, id, revision, title, pinned, created_at, updated_at, data_json, body_key)
       VALUES ('generation-user', ?, ?, 1, ?, 0, 1, 2, '{}', ?)`
    ).run(generation, id, id, key)
  }
  db.db.prepare(
    `INSERT INTO cloud_imports
       (user_id, id, generation, base_revision, status, count, created_at, updated_at)
     VALUES ('generation-user', 'new-import', 'import_new', 1, 'committed', 1, ?, ?)`
  ).run(now, now)
  db.beforeExecute = (sql) => {
    if (/DELETE FROM chats/i.test(sql)) {
      db.beforeExecute = undefined
      db.db.prepare(
        `UPDATE cloud_history SET generation = 'import_new', revision = 2
         WHERE user_id = 'generation-user'`
      ).run()
    }
  }

  try {
    await cleanupExpiredGenerations({
      DB: db,
      FILES: files,
    }, 'generation-user')
    assert.equal(files.objects.has('generation-user/chats/legacy/old'), false)
    assert.equal(files.objects.has('generation-user/chats/import_new/new'), true)
    assert.deepEqual(
      db.db.prepare(
        "SELECT generation, id FROM chats WHERE user_id = 'generation-user'"
      ).all().map((row) => ({ ...row })),
      [{ generation: 'import_new', id: 'new-chat' }]
    )
  } finally {
    db.close()
  }
})

test('分片上传刷新任务活动时间，cron 的旧快照 CAS 不会取消刚有活动的任务', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('activity_user')
    const imported = await harness.createImport(user)
    const started = await harness.api(user, '/api/storage/uploads', {
      method: 'POST',
      body: {
        kind: 'file',
        id: 'active-file',
        importId: imported.id,
        mimeType: 'text/plain',
      },
    })
    assert.equal(started.status, 201)
    const uploadId = (await started.json()).id
    const old = Date.now() - 25 * 60 * 60 * 1000
    harness.db.db.prepare(
      'UPDATE cloud_imports SET updated_at = ? WHERE user_id = ? AND id = ?'
    ).run(old, user.id, imported.id)
    harness.db.db.prepare(
      'UPDATE cloud_uploads SET updated_at = ? WHERE user_id = ? AND id = ?'
    ).run(old, user.id, uploadId)

    const part = await harness.api(user, `/api/storage/uploads/${uploadId}/parts/1`, {
      method: 'PUT',
      body: new Blob(['part activity']),
    })
    assert.equal(part.status, 200)
    assert.ok(
      harness.db.db.prepare(
        'SELECT updated_at FROM cloud_imports WHERE user_id = ? AND id = ?'
      ).get(user.id, imported.id).updated_at > old
    )
    assert.ok(
      harness.db.db.prepare(
        'SELECT updated_at FROM cloud_uploads WHERE user_id = ? AND id = ?'
      ).get(user.id, uploadId).updated_at > old
    )
  })
})

test('cleanupAbandonedStorage 的取消 CAS 复核活动时间，旧快照不能取消新分片任务', async () => {
  mkdirSync('test-results', { recursive: true })
  const output = 'test-results/cloudStorageActivityModule.mjs'
  await build({
    stdin: {
      contents: "export * from './server/cloudStorage.ts'",
      resolveDir: process.cwd(),
      sourcefile: 'cloud-storage-activity-test-entry.ts',
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
  })
  const { cleanupAbandonedStorage } = await import(`../${output}?${Date.now()}`)
  const db = new LocalD1()
  const files = new LocalR2()
  const now = Date.now()
  const old = now - 25 * 60 * 60 * 1000
  db.db.prepare(
    `INSERT INTO users
       (id, username, password_hash, role, status, created_at, auth_version)
     VALUES ('activity-cleanup-user', 'activity_cleanup', NULL, 'user', 'active', ?, 1)`
  ).run(now)
  db.db.prepare(
    `INSERT INTO cloud_history (user_id, generation, revision)
     VALUES ('activity-cleanup-user', 'legacy', 1)`
  ).run()
  db.db.prepare(
    `INSERT INTO cloud_imports
       (user_id, id, generation, base_revision, status, count, created_at, updated_at)
     VALUES ('activity-cleanup-user', 'active-import', 'import_active', 1,
             'staging', 0, ?, ?)`
  ).run(old, old)
  const multipart = await files.createMultipartUpload('activity-cleanup-user/uploads/active', {})
  db.db.prepare(
    `INSERT INTO cloud_uploads
       (user_id, id, kind, object_id, generation, import_id, r2_key, multipart_id,
        mime_type, status, created_at, updated_at)
     VALUES ('activity-cleanup-user', 'active-upload', 'file', 'active-file',
             'import_active', 'active-import', 'activity-cleanup-user/uploads/active',
             ?, 'text/plain', 'uploading', ?, ?)`
  ).run(multipart.uploadId, old, old)
  let refreshedUpload = false
  let refreshedImport = false
  db.beforeExecute = (sql) => {
    if (!refreshedUpload && /UPDATE cloud_uploads SET status = 'cancelled'/i.test(sql)) {
      refreshedUpload = true
      db.db.prepare(
        "UPDATE cloud_uploads SET updated_at = ? WHERE id = 'active-upload'"
      ).run(now)
    }
    if (!refreshedImport && /UPDATE cloud_imports SET status = 'cancelled'/i.test(sql)) {
      refreshedImport = true
      db.db.prepare(
        "UPDATE cloud_imports SET updated_at = ? WHERE id = 'active-import'"
      ).run(now)
    }
  }

  try {
    await cleanupAbandonedStorage({ DB: db, FILES: files })
    assert.equal(
      db.db.prepare("SELECT status FROM cloud_uploads WHERE id = 'active-upload'").get().status,
      'uploading'
    )
    assert.equal(
      db.db.prepare("SELECT status FROM cloud_imports WHERE id = 'active-import'").get().status,
      'staging'
    )
    assert.equal(files.multipartUploads.has(multipart.uploadId), true)
  } finally {
    db.close()
  }
})
