import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCloudHarness } from './helpers/cloudHarness.mjs'

const chat = (id, files = []) => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  messages: [{ id: 'message-1', role: 'user', createdAt: 1, content: '正文', files }],
})
const file = (id) => ({
  id,
  name: id,
  serverId: null,
  size: 0,
  isImage: false,
  mimeType: 'text/plain',
})
const withHarness = async (run) => {
  const harness = await createCloudHarness()
  try {
    await run(harness)
  } finally {
    await harness.dispose()
  }
}

test('批次正文四个并发写入，集合 SQL 保存全部附件引用，重复请求不覆写正文', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('direct_batch')
    const imported = await harness.createImport(user)
    const path = `/api/chats/imports/${imported.id}/chats`
    const sessions = Array.from({ length: 16 }, (_, index) =>
      chat(`chat-${index}`, [file('shared'), file(`file-${index}`)])
    )
    const gate = harness.gate()
    let active = 0,
      maximum = 0,
      puts = 0
    harness.files.beforePut = async () => {
      active++
      puts++
      maximum = Math.max(maximum, active)
      gate.markEntered()
      await gate.wait
      active--
    }
    const beforeQueries = harness.db.trace.length
    const writing = harness.api(user, path, { method: 'POST', body: { sessions } })
    try {
      await harness.waitUntil(() => active === 4)
      gate.release()
      const response = await writing
      assert.equal(response.status, 200)
      assert.equal((await response.json()).count, 16)
    } finally {
      gate.release()
      await writing
    }
    assert.equal(maximum, 4)
    assert.equal(puts, 16)
    assert.ok(
      [...harness.files.objects.keys()].every((key) => {
        const parts = key.split('/')
        return parts.length === 5 && /^[A-Za-z0-9_-]+$/.test(parts[3])
      }),
      '上传摘要必须采用安全编码，不产生额外路径层级'
    )
    assert.ok(
      harness.db.trace.length - beforeQueries < 25,
      '批次不应逐个会话或引用重复执行数据库查询'
    )
    assert.equal(
      harness.db.db
        .prepare('SELECT COUNT(*) AS n FROM chat_files WHERE generation = ?')
        .get(imported.generation).n,
      32
    )
    const repeat = await harness.api(user, path, { method: 'POST', body: { sessions } })
    assert.equal(repeat.status, 200)
    assert.equal(puts, 16)
    assert.equal(
      (
        await harness.api(user, path, {
          method: 'POST',
          body: { sessions: [{ ...sessions[0], title: '变化' }] },
        })
      ).status,
      409
    )
    assert.equal(puts, 16)
    const completed = await harness.api(user, `/api/chats/imports/${imported.id}/commit`, {
      method: 'POST',
      body: { count: 16 },
    })
    assert.equal(completed.status, 200)
    assert.equal((await harness.loadSessionAs(user, 'chat-0')).messages[0].files.length, 2)
  })
})

test('普通附件提交前不可读，空原件合法，重复或冲突内容不改变已保存对象', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('direct_empty_file')
    const imported = await harness.createImport(user)
    const path = `/api/chats/imports/${imported.id}/files/empty`
    const upload = (body) =>
      harness.api(user, path, {
        method: 'PUT',
        body: new Blob([body]),
        headers: { 'Content-Type': 'text/plain' },
      })
    assert.equal((await upload('')).status, 200)
    assert.equal((await upload('')).status, 200)
    assert.equal((await upload('changed')).status, 409)
    assert.equal((await harness.api(user, '/api/files/empty')).status, 404)
    assert.equal(
      (
        await harness.api(user, `/api/chats/imports/${imported.id}/chats`, {
          method: 'POST',
          body: { sessions: [chat('empty-chat', [file('empty')])] },
        })
      ).status,
      200
    )
    assert.equal(
      (
        await harness.api(user, `/api/chats/imports/${imported.id}/commit`, {
          method: 'POST',
          body: { count: 1 },
        })
      ).status,
      200
    )
    const original = await harness.api(user, '/api/files/empty')
    assert.equal(original.status, 200)
    assert.equal((await original.arrayBuffer()).byteLength, 0)
  })
})

test('会话或附件的 R2 写入和 D1 发布失败均返回 500，取消后没有残留对象', async () => {
  for (const kind of ['chat', 'file']) {
    for (const phase of ['r2', 'd1']) {
      await withHarness(async (harness) => {
        const user = await harness.addUser(`direct_fail_${kind}_${phase}`)
        const imported = await harness.createImport(user)
        if (phase === 'r2')
          harness.files.afterPut = () => {
            throw new Error('真实 R2 写入失败')
          }
        else
          harness.db.failNext(
            kind === 'chat' ? /INSERT INTO chats/ : /INSERT INTO cloud_archive_files/
          )
        const response = await harness.api(
          user,
          `/api/chats/imports/${imported.id}/${kind === 'chat' ? 'chats' : 'files/original'}`,
          {
            method: kind === 'chat' ? 'POST' : 'PUT',
            body: kind === 'chat' ? { sessions: [chat('failed-chat')] } : new Blob(['original']),
            headers: kind === 'file' ? { 'Content-Type': 'text/plain' } : {},
          }
        )
        assert.equal(response.status, 500)
        assert.equal(harness.files.objects.size, 0)
        assert.equal(
          (await harness.api(user, `/api/chats/imports/${imported.id}`, { method: 'DELETE' }))
            .status,
          204
        )
        assert.deepEqual((await harness.snapshotAs(user)).sessions, [])
        assert.equal(harness.files.objects.size, 0)
      })
    }
  }
})

test('取消和直接写入并发，后到的对象不能发布且会被清理', async () => {
  for (const kind of ['chat', 'file']) {
    await withHarness(async (harness) => {
      const user = await harness.addUser(`direct_cancel_${kind}`)
      const imported = await harness.createImport(user)
      const gate = harness.gate()
      harness.files.beforePut = async () => {
        gate.markEntered()
        await gate.wait
      }
      const writing = harness.api(
        user,
        `/api/chats/imports/${imported.id}/${kind === 'chat' ? 'chats' : 'files/original'}`,
        {
          method: kind === 'chat' ? 'POST' : 'PUT',
          body: kind === 'chat' ? { sessions: [chat('cancelled-chat')] } : new Blob(['original']),
          headers: kind === 'file' ? { 'Content-Type': 'text/plain' } : {},
        }
      )
      try {
        await gate.entered
        assert.equal(
          (await harness.api(user, `/api/chats/imports/${imported.id}`, { method: 'DELETE' }))
            .status,
          204
        )
        gate.release()
        assert.equal((await writing).status, 409)
      } finally {
        gate.release()
        await writing
      }
      assert.equal(harness.files.objects.size, 0)
      assert.deepEqual((await harness.snapshotAs(user)).sessions, [])
    })
  }
})

test('相互重叠的并发批次拒绝重复写入权，不登记部分任务或覆盖已完成正文', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('direct_overlap')
    const imported = await harness.createImport(user)
    const path = `/api/chats/imports/${imported.id}/chats`
    const gate = harness.gate()
    harness.files.beforePut = async () => {
      gate.markEntered()
      await gate.wait
    }
    const sessions = [chat('overlap-a'), chat('overlap-b')]
    const first = harness.api(user, path, { method: 'POST', body: { sessions } })
    try {
      await gate.entered
      assert.equal(
        (
          await harness.api(user, path, {
            method: 'POST',
            body: { sessions: [chat('overlap-b'), chat('overlap-c')] },
          })
        ).status,
        409
      )
      assert.equal(
        harness.db.db
          .prepare('SELECT COUNT(*) AS n FROM cloud_uploads WHERE import_id = ?')
          .get(imported.id).n,
        2
      )
      gate.release()
      assert.equal((await first).status, 200)
    } finally {
      gate.release()
      await first
    }
    assert.equal(
      (
        await harness.api(user, path, {
          method: 'POST',
          body: { sessions: [chat('overlap-b'), chat('overlap-c')] },
        })
      ).status,
      200
    )
    assert.equal(harness.files.objects.size, 3)
    assert.equal(
      (
        await harness.api(user, `/api/chats/imports/${imported.id}/commit`, {
          method: 'POST',
          body: { count: 3 },
        })
      ).status,
      200
    )
    assert.equal((await harness.loadSessionAs(user, 'overlap-b')).title, 'overlap-b')
  })
})

test('取消已完成暂存内容可重复执行，不影响账号原有历史和附件', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('direct_complete_cancel')
    await harness.saveSessionAs(user, chat('keep'))
    const original = await harness.snapshotAs(user)
    const existingKeys = [...harness.files.objects.keys()]
    const imported = await harness.createImport(user)
    const path = `/api/chats/imports/${imported.id}`
    assert.equal(
      (
        await harness.api(user, path + '/chats', {
          method: 'POST',
          body: { sessions: [chat('temporary')] },
        })
      ).status,
      200
    )
    assert.equal(
      (
        await harness.api(user, path + '/files/temporary', {
          method: 'PUT',
          body: new Blob(['original']),
          headers: { 'Content-Type': 'text/plain' },
        })
      ).status,
      200
    )
    for (let attempt = 0; attempt < 2; attempt++)
      assert.equal((await harness.api(user, path, { method: 'DELETE' })).status, 204)
    assert.deepEqual(await harness.snapshotAs(user), original)
    assert.deepEqual([...harness.files.objects.keys()], existingKeys)
  })
})

test('批次数量和实际 UTF-8 大小超过边界时拒绝请求，不写入对象', async () => {
  await withHarness(async (harness) => {
    const user = await harness.addUser('direct_limits')
    const imported = await harness.createImport(user)
    const path = `/api/chats/imports/${imported.id}/chats`
    assert.equal(
      (
        await harness.api(user, path, {
          method: 'POST',
          body: { sessions: Array.from({ length: 17 }, (_, index) => chat(`limit-${index}`)) },
        })
      ).status,
      400
    )
    const large = chat('large')
    large.messages[0].content = '中文'.repeat(45000)
    assert.equal(
      (await harness.api(user, path, { method: 'POST', body: { sessions: [large] } })).status,
      413
    )
    assert.equal(harness.files.objects.size, 0)
  })
})
