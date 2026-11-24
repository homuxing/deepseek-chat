import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkerCloudHarness, removeWorkerCloudBundle } from './helpers/workerCloudHarness.mjs'

const withHarness = async (run, options) => {
  const harness = await createWorkerCloudHarness(options)
  try {
    return await run(harness)
  } finally {
    await harness.dispose()
  }
}

const sessionDocument = ({ id, title, content, fileId, updatedAt, pinned = false }) => ({
  id,
  title,
  createdAt: updatedAt - 60_000,
  updatedAt,
  pinned,
  rootMessageId: `${id}-user`,
  messages: [
    {
      id: `${id}-user`,
      parentId: null,
      role: 'user',
      content: '导入 synthetic 对话',
      createdAt: updatedAt - 2_000,
      files: fileId
        ? [
            {
              id: fileId,
              serverId: null,
              name: 'synthetic.txt',
              size: 32,
              isImage: false,
              mimeType: '',
            },
          ]
        : [],
    },
    {
      id: `${id}-assistant`,
      parentId: `${id}-user`,
      role: 'assistant',
      blocks: [{ type: 'text', content }],
      prefix: false,
      status: 'FINISHED',
      createdAt: updatedAt - 1_000,
    },
  ],
})

test(
  '真实 Worker 完成 0001-0004、大于 8 MiB multipart、提交后跨设备读取及 DO 同步隔离',
  { timeout: 120_000 },
  async () => {
    await withHarness(
      async (harness) => {
        const migrated = await harness.initialize()
        const migrationNames = readdirSync(join(process.cwd(), 'migrations'))
          .filter((name) => name.endsWith('.sql'))
          .sort()
        assert.deepEqual(migrated.applied, migrationNames)
        assert.ok(migrated.tables.includes('cloud_history'))
        assert.ok(migrated.tables.includes('cloud_imports'))
        assert.ok(migrated.tables.includes('cloud_uploads'))
        assert.ok(migrated.tables.includes('cloud_upload_parts'))
        assert.ok(migrated.tables.includes('cloud_chat_refs'))
        assert.equal(migrated.statementCounts['0003_session_renewal.sql'], 5)
        assert.match(harness.miniflareOrigin, /^http:\/\/127\.0\.0\.1:\d+$/)
        const page = await fetch(`${harness.miniflareOrigin}/`)
        assert.equal(page.status, 200)
        const html = await page.text()
        assert.match(html, /<div id="root"><\/div>/)
        const scriptPath = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1]
        assert.ok(scriptPath)
        const script = await fetch(`${harness.miniflareOrigin}${scriptPath}`)
        assert.equal(script.status, 200)
        assert.match(script.headers.get('content-type') ?? '', /javascript/)

        const foreignKeyState = await harness.query('PRAGMA foreign_keys')
        assert.equal(Number(Object.values(foreignKeyState[0])[0]), 1)
        assert.deepEqual(await harness.query('PRAGMA foreign_key_check'), [])

        const alice = await harness.addAccount('cloud_alice')
        const bob = await harness.addAccount('cloud_bob')
        const aliceFirst = await harness.openSync(alice)
        const aliceSecond = await harness.openSync(alice)
        const bobSocket = await harness.openSync(bob)

        const importStart = await harness.expectApi(alice, '/api/chats/imports', {
          method: 'POST',
          body: {},
        })
        assert.equal(importStart.response.status, 201)
        const importTask = importStart.value

        const fileBytes = new TextEncoder().encode('synthetic multipart attachment')
        const uploadedFile = await harness.uploadFile(alice, {
          id: 'synthetic-file-1',
          generation: importTask.generation,
          expectedRevision: importTask.revision,
          importId: importTask.id,
          mimeType: 'text/plain',
          bytes: fileBytes,
        })
        assert.ok(
          uploadedFile.completed,
          `文件上传完成响应缺少正文: ${JSON.stringify(uploadedFile)}`
        )
        assert.equal(uploadedFile.completed.file.id, 'synthetic-file-1')

        const prefix = 'large-answer-start:'
        const suffix = ':large-answer-end'
        const content = prefix + 'x'.repeat(8 * 1024 * 1024 + 256 * 1024) + suffix
        const session = sessionDocument({
          id: 'synthetic-large-chat',
          title: 'Synthetic ZIP 235',
          content,
          fileId: 'synthetic-file-1',
          updatedAt: 1_711_111_111_111,
          pinned: true,
        })
        const uploadedChat = await harness.uploadChat(alice, {
          id: session.id,
          generation: importTask.generation,
          expectedRevision: importTask.revision,
          importId: importTask.id,
          session,
        })

        assert.equal(uploadedChat.partCount, 2)
        assert.equal(uploadedChat.uploading.status, 'uploading')
        assert.equal(uploadedChat.afterParts.status, 'uploading')
        assert.equal(uploadedChat.status.status, 'completed')
        assert.deepEqual(uploadedChat.status.summary, {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          pinned: true,
          revision: importTask.revision,
          generation: importTask.generation,
        })
        const uploadMetadata = (
          await harness.query(
            'SELECT summary_json AS summaryJson, files_json AS filesJson FROM cloud_uploads WHERE user_id = ? AND id = ?',
            [alice.id, uploadedChat.uploadId]
          )
        )[0]
        assert.equal(uploadMetadata.filesJson, '[]')
        assert.deepEqual(JSON.parse(uploadMetadata.summaryJson), {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          pinned: true,
        })
        assert.equal(aliceFirst.hasUnread('changed'), false)
        assert.equal(aliceSecond.hasUnread('changed'), false)
        assert.equal(bobSocket.hasUnread('changed'), false)

        const committed = await harness.expectApi(
          alice,
          `/api/chats/imports/${encodeURIComponent(importTask.id)}/commit`,
          { method: 'POST', body: { count: 1 } }
        )
        assert.equal(committed.value.count, 1)
        assert.equal(committed.value.generation, importTask.generation)
        assert.ok(committed.value.revision > importTask.revision)
        await aliceFirst.waitForType('changed')
        await aliceSecond.waitForType('changed')
        await assert.rejects(bobSocket.waitForType('changed', 400), /超时/)

        await harness.notifyUser(alice.id)
        await aliceFirst.waitForType('changed')
        await aliceSecond.waitForType('changed')
        await assert.rejects(bobSocket.waitForType('changed', 400), /超时/)

        const summaryBeforeRename = (await harness.expectApi(alice, '/api/chats')).value.sessions[0]
        const renamed = await harness.expectApi(alice, `/api/chats/${session.id}`, {
          method: 'PATCH',
          headers: {
            'X-Chat-Generation': summaryBeforeRename.generation,
            'X-Chat-Revision': String(summaryBeforeRename.revision),
          },
          body: { title: '另一设备更新' },
        })
        assert.equal(renamed.value.summary.title, '另一设备更新')
        await aliceFirst.waitForType('changed')
        await aliceSecond.waitForType('changed')
        await assert.rejects(bobSocket.waitForType('changed', 400), /超时/)

        const list = await harness.expectApi(alice, '/api/chats')
        assert.equal(list.value.generation, committed.value.generation)
        assert.deepEqual(
          list.value.sessions.map((item) => item.id),
          [session.id]
        )

        const newDevice = await harness.addSession(alice)
        const newDeviceList = await harness.expectApi(newDevice, '/api/chats')
        assert.deepEqual(
          newDeviceList.value.sessions.map((item) => item.id),
          [session.id]
        )
        const loaded = await harness.expectApi(
          newDevice,
          `/api/chats/${encodeURIComponent(session.id)}`
        )
        const loadedContent = loaded.value.session.messages[1].blocks[0].content
        assert.equal(loadedContent.length, content.length)
        assert.ok(loadedContent.startsWith(prefix))
        assert.ok(loadedContent.endsWith(suffix))
        assert.equal(loaded.value.session.messages[0].files[0].mimeType, 'text/plain')
        assert.deepEqual(
          await harness.query(
            'SELECT file_id AS fileId FROM chat_files WHERE user_id = ? AND generation = ? AND chat_id = ?',
            [alice.id, importTask.generation, session.id]
          ),
          [{ fileId: 'synthetic-file-1' }]
        )
        assert.deepEqual(
          await harness.query('SELECT body_key, file_id FROM cloud_chat_refs WHERE user_id = ?', [
            alice.id,
          ]),
          []
        )

        const deleted = await harness.api(newDevice, `/api/chats/${session.id}`, {
          method: 'DELETE',
          headers: {
            'X-Chat-Generation': loaded.value.summary.generation,
            'X-Chat-Revision': String(loaded.value.summary.revision),
          },
        })
        assert.equal(deleted.status, 204)
        await aliceFirst.waitForType('changed')
        await aliceSecond.waitForType('changed')
        await assert.rejects(bobSocket.waitForType('changed', 400), /超时/)
        assert.deepEqual((await harness.expectApi(alice, '/api/chats')).value.sessions, [])

        await harness.revokeAccount(alice)
        await harness.notifyUser(alice.id)
        await harness.waitFor(
          () =>
            (aliceFirst.closeInfo || aliceFirst.socket.readyState >= 2) &&
            (aliceSecond.closeInfo || aliceSecond.socket.readyState >= 2),
          'DO 撤销会话后连接未进入关闭流程',
          5_000
        )
        assert.deepEqual(
          await harness.query(
            'SELECT user_id AS userId, token_hash AS tokenHash FROM auth_sessions WHERE user_id = ?',
            [alice.id]
          ),
          []
        )
        const expired = await harness.api(alice, '/api/chats')
        assert.equal(expired.status, 401)
        assert.equal(expired.headers.get('X-Auth-Expired'), '1')
        for (const socket of [aliceFirst, aliceSecond]) {
          if (socket.closeInfo) {
            assert.equal(socket.closeInfo.code, 1008)
          } else {
            assert.equal(socket.socket.readyState, 2)
          }
          assert.equal(socket.messages.filter((message) => message.type === 'changed').length, 4)
        }
        assert.equal(bobSocket.closeInfo, null)
        assert.equal(bobSocket.hasUnread('changed'), false)
      },
      { assetsPath: join(process.cwd(), 'dist') }
    )
  }
)

test.after(removeWorkerCloudBundle)
