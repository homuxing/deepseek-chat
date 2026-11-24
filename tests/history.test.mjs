import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('test-results', { recursive: true })
await build({
  stdin: {
    contents: `
      export {
        ArchiveError,
        isZipFile,
        readArchive,
        readEntry,
      } from './src/services/chat/history/zipReader.ts'
      export { importArchive, checkArchiveFormat } from './src/services/chat/history/importArchive.ts'
      export { exportArchive } from './src/services/chat/history/exportArchive.ts'
      export { writeArchive } from './src/services/chat/history/zipWriter.ts'
      export { toLocalSession } from './src/services/chat/history/toLocal.ts'
      export { toSessionFile } from './src/services/chat/history/toArchive.ts'
      export {
        INDEX_PATH,
        MANIFEST_PATH,
        USER_PATH,
        filePath,
        sessionPath,
      } from './src/services/chat/history/paths.ts'
      export { EXPORT_FORMAT_VERSION } from './src/services/chat/history/format.ts'
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: 'test-results/history.mjs',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
})
const history = await import('../test-results/history.mjs')

const iso = (second = 0) => `2026-11-24T01:02:${String(second).padStart(2, '0')}.000Z`
const json = (value) => new Blob([JSON.stringify(value)], { type: 'application/json' })
const file = (name) => new File([name], name, { type: 'application/zip' })

const createSink = () => {
  const sessions = []
  const files = new Map()
  const events = []
  let types
  let typeUpdates = 0
  return {
    sessions,
    files,
    events,
    get types() {
      return types
    },
    get typeUpdates() {
      return typeUpdates
    },
    sink: {
      addSession: async (session) => {
        events.push(`session:${session.id}`)
        sessions.push(session)
      },
      saveFiles: async (items) => {
        for (const item of items) {
          events.push(`file:${item.id}`)
          files.set(item.id, item.blob)
        }
      },
      updateFileTypes: async (value) => {
        typeUpdates++
        types = value
      },
    },
  }
}

const message = (id, parentId, role, fragments, second = id) => ({
  id,
  parent_id: parentId,
  role,
  status: role === 'USER' ? 'FINISHED' : 'FINISHED',
  thinking_enabled: role === 'ASSISTANT',
  search_enabled: role === 'ASSISTANT',
  accumulated_token_usage: 0,
  inserted_at: iso(second),
  fragments,
})

const attachment = (id, name, isImage, exportPath, size = 8) => ({
  id,
  file_name: name,
  file_size: size,
  token_usage: null,
  inserted_at: iso(1),
  export_path: exportPath,
  is_image: isImage,
  width: null,
  height: null,
})

const sessionFile = (id, pinned = false) => {
  const imagePath = history.filePath(id, 'image-1', 'synthetic.png')
  const documentPath = history.filePath(id, 'document-1', 'synthetic.pdf')
  const missingPath = history.filePath(id, 'document-missing', 'missing.txt')
  return {
    id,
    title: 'Synthetic archive',
    pinned,
    current_message_id: 4,
    inserted_at: iso(0),
    updated_at: iso(8),
    messages: [
      message(1, null, 'USER', [
        {
          type: 'FILE',
          files: [
            attachment('image-1', 'synthetic.png', true, imagePath, 8),
            attachment('document-1', 'synthetic.pdf', false, documentPath, 8),
            attachment('document-missing', 'missing.txt', false, missingPath, 99),
          ],
        },
        { type: 'REQUEST', content: 'Question with originals' },
      ]),
      message(2, 1, 'ASSISTANT', [
        { type: 'THINK', content: 'Synthetic reasoning', elapsed_secs: 1.25 },
        { type: 'RESPONSE', content: 'Synthetic answer' },
        {
          type: 'TOOL_SEARCH',
          queries: ['synthetic query'],
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
      ]),
      message(3, 2, 'USER', [{ type: 'REQUEST', content: 'Continue the branch' }]),
      message(4, 3, 'ASSISTANT', [{ type: 'RESPONSE', content: 'Current branch answer' }]),
      message(5, 3, 'ASSISTANT', [{ type: 'RESPONSE', content: 'Alternate answer' }]),
      message(6, 5, 'USER', [{ type: 'REQUEST', content: 'Alternate branch' }]),
    ],
  }
}

const indexEntry = (session) => ({
  id: session.id,
  title: session.title,
  pinned: session.pinned,
  message_count: session.messages.length,
  inserted_at: session.inserted_at,
  updated_at: session.updated_at,
})

// 合成的 1×1 PNG，具备完整文件结构；测试中不使用真实对话或附件。
const sharedImage = new Blob([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=',
    'base64'
  ),
])
const sharedDocument = new Blob(['%PDF-1.7\nSynthetic shared document\n%%EOF\n'])

const sharedSession = (id, imageName = 'shared.png') => {
  const session = sessionFile(id, true)
  const files = [
    attachment(
      'image-1',
      imageName,
      true,
      history.filePath(id, 'image-1', imageName),
      sharedImage.size
    ),
    attachment(
      'document-1',
      'shared.pdf',
      false,
      history.filePath(id, 'document-1', 'shared.pdf'),
      sharedDocument.size
    ),
  ]
  session.messages[0].fragments[0].files = files
  // 同一会话的下一轮也引用相同 ID、相同路径，用于检查导出不会重复写入原件。
  const followupFiles = structuredClone(files)
  followupFiles[0].file_name = `follow-up-${imageName}`
  session.messages[2].fragments.unshift({ type: 'FILE', files: followupFiles })
  return session
}

const sharedEntries = (sessions) => {
  const manifest = { name: history.MANIFEST_PATH, blob: json({ export_format_version: 3 }) }
  const index = { name: history.INDEX_PATH, blob: json(sessions.map(indexEntry)) }
  const conversations = sessions.map((session) => ({
    name: history.sessionPath(session.id),
    blob: json(session),
  }))
  const originals = sessions.flatMap((session) =>
    session.messages[0].fragments[0].files.map((item) => ({
      name: item.export_path,
      blob: item.is_image ? sharedImage : sharedDocument,
    }))
  )
  return { manifest, index, conversations, originals }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 生成小条目 ZIP64，用于验证 64 位目录和字段解析路径。 */
const createZip64 = (entries) => {
  const encoder = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data =
      typeof entry.data === 'string' ? encoder.encode(entry.data) : new Uint8Array(entry.data)
    const crc = crc32(data)
    const localOffset = offset
    const local = new Uint8Array(30 + name.length + 20)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 45, true)
    localView.setUint16(6, 0x800, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, 0xffffffff, true)
    localView.setUint32(22, 0xffffffff, true)
    localView.setUint16(26, name.length, true)
    localView.setUint16(28, 20, true)
    local.set(name, 30)
    const localExtra = new DataView(local.buffer, 30 + name.length, 20)
    localExtra.setUint16(0, 1, true)
    localExtra.setUint16(2, 16, true)
    localExtra.setBigUint64(4, BigInt(data.length), true)
    localExtra.setBigUint64(12, BigInt(data.length), true)
    parts.push(local, data)
    offset += local.length + data.length

    const record = new Uint8Array(46 + name.length + 28)
    const view = new DataView(record.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 0x032d, true)
    view.setUint16(6, 45, true)
    view.setUint16(8, 0x800, true)
    view.setUint32(16, crc, true)
    view.setUint32(20, 0xffffffff, true)
    view.setUint32(24, 0xffffffff, true)
    view.setUint16(28, name.length, true)
    view.setUint16(30, 28, true)
    view.setUint32(38, 0x81a40000, true)
    view.setUint32(42, 0xffffffff, true)
    record.set(name, 46)
    const extra = new DataView(record.buffer, 46 + name.length, 28)
    extra.setUint16(0, 1, true)
    extra.setUint16(2, 24, true)
    extra.setBigUint64(4, BigInt(data.length), true)
    extra.setBigUint64(12, BigInt(data.length), true)
    extra.setBigUint64(20, BigInt(localOffset), true)
    central.push(record)
  }
  const directoryOffset = offset
  const directorySize = central.reduce((sum, item) => sum + item.length, 0)
  const recordOffset = directoryOffset + directorySize
  const record = new Uint8Array(56)
  const recordView = new DataView(record.buffer)
  recordView.setUint32(0, 0x06064b50, true)
  recordView.setBigUint64(4, 44n, true)
  recordView.setUint16(12, 45, true)
  recordView.setUint16(14, 45, true)
  recordView.setBigUint64(24, BigInt(entries.length), true)
  recordView.setBigUint64(32, BigInt(entries.length), true)
  recordView.setBigUint64(40, BigInt(directorySize), true)
  recordView.setBigUint64(48, BigInt(directoryOffset), true)
  const locator = new Uint8Array(20)
  const locatorView = new DataView(locator.buffer)
  locatorView.setUint32(0, 0x07064b50, true)
  locatorView.setBigUint64(8, BigInt(recordOffset), true)
  locatorView.setUint32(16, 1, true)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, 0xffff, true)
  endView.setUint16(10, 0xffff, true)
  endView.setUint32(12, 0xffffffff, true)
  endView.setUint32(16, 0xffffffff, true)
  return new Blob([...parts, ...central, record, locator, end])
}

test('官方风格会话流式导入，保留分支、正文、思考、搜索、pinned 和全部原件映射', async () => {
  const session = sessionFile('session-1', true)
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const document = new TextEncoder().encode('%PDF-1.7')
  const archive = await history.writeArchive([
    { name: history.MANIFEST_PATH, blob: json({ export_format_version: 3 }) },
    { name: history.USER_PATH, blob: json({ email: 'masked@example.com' }) },
    { name: history.INDEX_PATH, blob: json([indexEntry(session)]) },
    {
      name: history.filePath(session.id, 'image-1', 'synthetic.png'),
      blob: new Blob([image]),
    },
    { name: history.sessionPath(session.id), blob: json(session) },
    {
      name: history.filePath(session.id, 'document-1', 'synthetic.pdf'),
      blob: new Blob([document]),
    },
  ])
  const capture = createSink()

  await history.importArchive(file(archive), capture.sink)

  assert.equal(capture.sessions.length, 1)
  const imported = capture.sessions[0]
  assert.equal(imported.pinned, true)
  assert.equal(imported.messages.length, 6)
  assert.equal(imported.rootMessageId, '1')
  assert.equal(imported.messages.find((item) => item.id === '1').selectedChildId, '2')
  assert.equal(imported.messages.find((item) => item.id === '2').selectedChildId, '3')
  assert.equal(imported.messages.find((item) => item.id === '3').selectedChildId, '4')
  assert.equal(imported.messages.find((item) => item.id === '1').role, 'user')
  assert.equal(imported.messages.find((item) => item.id === '2').thinking, true)
  assert.equal(imported.messages.find((item) => item.id === '2').search, true)
  assert.deepEqual(
    imported.messages.find((item) => item.id === '2').blocks.map((block) => block.type),
    ['thinking', 'text', 'server_tool_use', 'web_search_tool_result']
  )
  assert.equal(imported.messages.find((item) => item.id === '2').blocks[1].text, 'Synthetic answer')

  const user = imported.messages.find((item) => item.id === '1')
  assert.equal(user.files.length, 3)
  assert.equal(user.files[0].mimeType, '')
  assert.equal(user.files[2].size, 99)
  assert.deepEqual(capture.events, ['file:image-1', 'session:session-1', 'file:document-1'])
  assert.deepEqual([...capture.files.keys()].sort(), ['document-1', 'image-1'])
  assert.equal(capture.files.get('image-1').type, 'image/png')
  assert.equal(capture.files.get('document-1').type, 'application/pdf')
  assert.equal(capture.types.get('image-1'), 'image/png')
  assert.equal(capture.types.get('document-1'), 'application/pdf')
  assert.equal(capture.types.has('document-missing'), false)

  const exported = history.toSessionFile(imported, ({ id, name }) =>
    id === 'document-missing' ? null : history.filePath(imported.id, id, name)
  )
  assert.equal(exported.pinned, true)
  assert.equal(exported.messages[0].fragments[0].files.length, 3)
  assert.equal(exported.messages[0].fragments[0].files[2].export_path, null)

  const exportedOriginals = exported.messages[0].fragments[0].files.flatMap((item) => {
    const blob = capture.files.get(item.id)
    return item.export_path && blob ? [{ name: item.export_path, blob }] : []
  })
  const roundTripArchive = await history.writeArchive([
    { name: history.MANIFEST_PATH, blob: json({ export_format_version: 3 }) },
    { name: history.sessionPath(exported.id), blob: json(exported) },
    { name: history.INDEX_PATH, blob: json([indexEntry(exported)]) },
    ...exportedOriginals,
  ])
  const roundTrip = createSink()
  await history.importArchive(file(roundTripArchive), roundTrip.sink)
  assert.equal(roundTrip.sessions[0].pinned, true)
  assert.deepEqual([...roundTrip.files.keys()].sort(), ['document-1', 'image-1'])
})

test('pinned 缺省为 false，长会话与当前分支线性化不依赖递归', async () => {
  const count = 6000
  const messages = Array.from({ length: count }, (_, index) => {
    const id = index + 1
    const role = index % 2 === 0 ? 'USER' : 'ASSISTANT'
    return message(
      id,
      id === 1 ? null : id - 1,
      role,
      role === 'USER'
        ? [{ type: 'REQUEST', content: `Question ${id}` }]
        : [{ type: 'RESPONSE', content: `Answer ${id}` }],
      id % 60
    )
  })
  const session = {
    id: 'long-session',
    title: 'Long session',
    current_message_id: count,
    inserted_at: iso(0),
    updated_at: iso(59),
    messages,
  }
  const archive = await history.writeArchive([
    { name: history.MANIFEST_PATH, blob: json({ export_format_version: 3 }) },
    { name: history.sessionPath(session.id), blob: json(session) },
    { name: history.INDEX_PATH, blob: json([indexEntry({ ...session, pinned: false })]) },
  ])
  const capture = createSink()

  await history.importArchive(file(archive), capture.sink)
  assert.equal(capture.sessions[0].pinned, undefined)
  assert.equal(capture.sessions[0].messages.length, count)
  const exported = history.toSessionFile(capture.sessions[0], () => null)
  assert.equal(exported.messages.length, count)
  assert.equal(exported.current_message_id, count)
})

test('拒绝截断 ZIP、重复条目路径和同一会话内同一文件 ID 的不同原件路径', async () => {
  const valid = await history.writeArchive([
    { name: history.MANIFEST_PATH, blob: json({ export_format_version: 3 }) },
    { name: history.INDEX_PATH, blob: json([]) },
  ])
  const bytes = new Uint8Array(await valid.arrayBuffer())
  const capture = createSink()
  await assert.rejects(
    history.importArchive(file(bytes.subarray(0, bytes.length - 10)), capture.sink),
    /不完整|incomplete/i
  )
  await assert.rejects(
    history.writeArchive([
      { name: history.MANIFEST_PATH, blob: json({ export_format_version: 3 }) },
      { name: history.MANIFEST_PATH, blob: json({ export_format_version: 3 }) },
    ]),
    /Invalid history archive entry/
  )

  const duplicate = sessionFile('duplicate-session')
  duplicate.messages[0].fragments[0].files.push(
    attachment(
      'image-1',
      'other.png',
      true,
      history.filePath(duplicate.id, 'image-1', 'other.png'),
      8
    )
  )
  assert.throws(() => history.toLocalSession(duplicate), /附件数据|attachment data/i)

  const duplicateArchiveSession = sessionFile('archive-duplicate')
  const duplicateArchive = await history.writeArchive([
    { name: history.MANIFEST_PATH, blob: json({ export_format_version: 3 }) },
    {
      name: history.filePath(duplicateArchiveSession.id, 'image-1', 'first.png'),
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]),
    },
    {
      name: history.filePath(duplicateArchiveSession.id, 'image-1', 'second.png'),
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]),
    },
    { name: history.sessionPath(duplicateArchiveSession.id), blob: json(duplicateArchiveSession) },
    {
      name: history.INDEX_PATH,
      blob: json([indexEntry(duplicateArchiveSession)]),
    },
  ])
  await assert.rejects(
    history.importArchive(file(duplicateArchive), createSink().sink),
    /附件数据|attachment data/i
  )
})

test('跨会话共享图片和文档可 roundtrip，原件先于会话及交错顺序均保留统一 ID', async () => {
  const sessions = [
    sharedSession('shared-session-a'),
    sharedSession('shared-session-b', 'renamed.png'),
  ]
  const { manifest, index, conversations, originals } = sharedEntries(sessions)
  const orders = [
    [manifest, ...originals, index, ...conversations],
    [manifest, index, ...conversations, ...originals],
    [
      manifest,
      originals[0],
      conversations[0],
      originals[2],
      index,
      conversations[1],
      originals[1],
      originals[3],
    ],
  ]

  for (const entries of orders) {
    const capture = createSink()
    await history.importArchive(file(await history.writeArchive(entries)), capture.sink)
    assert.equal(capture.sessions.length, 2)
    assert.deepEqual([...capture.files.keys()].sort(), ['document-1', 'image-1'])
    assert.equal(capture.events.filter((event) => event.startsWith('file:')).length, 2)
    assert.equal(capture.files.get('image-1').type, 'image/png')
    assert.equal(capture.files.get('document-1').type, 'application/pdf')
    assert.equal(capture.types.size, 2)
    assert.equal(capture.typeUpdates, 1)
    if (entries === orders[0]) {
      assert.deepEqual(capture.events.slice(0, 2), ['file:image-1', 'file:document-1'])
    }

    const loads = []
    const exported = await history.exportArchive(capture.sessions, async (id) => {
      loads.push(id)
      return capture.files.get(id)
    })
    assert.deepEqual(loads.sort(), ['document-1', 'image-1'])
    const exportedEntries = []
    for await (const entry of history.readArchive(file(exported))) {
      exportedEntries.push({ name: entry.path, blob: await history.readEntry(entry) })
    }
    const exportedSessions = exportedEntries.filter((entry) =>
      /^chat_sessions\/[^/]+\.json$/.test(entry.name)
    )
    const exportedOriginals = exportedEntries.filter((entry) => entry.name.includes('_files/'))
    assert.equal(exportedOriginals.length, 4)
    for (const entry of exportedSessions) {
      const session = JSON.parse(await entry.blob.text())
      const attachments = session.messages.flatMap((message) =>
        message.fragments.flatMap((fragment) => (fragment.type === 'FILE' ? fragment.files : []))
      )
      assert.equal(attachments.length, 4)
      const paths = new Map()
      for (const attachment of attachments) {
        assert.equal(
          attachment.export_path,
          paths.get(attachment.id) ??
            history.filePath(session.id, attachment.id, attachment.file_name)
        )
        assert.equal(paths.get(attachment.id) ?? attachment.export_path, attachment.export_path)
        paths.set(attachment.id, attachment.export_path)
        const original = exportedOriginals.find((entry) => entry.name === attachment.export_path)
        assert.ok(original)
        assert.deepEqual(
          await original.blob.arrayBuffer(),
          await capture.files.get(attachment.id).arrayBuffer()
        )
      }
    }

    // 将导出的原件挪到会话之前，验证完整归档与顺序变化后的归档均能恢复同一正文和分支。
    const originalsFirst = await history.writeArchive([
      exportedEntries[0],
      ...exportedOriginals,
      ...exportedEntries.filter((entry) => entry.name === history.INDEX_PATH),
      ...exportedSessions,
    ])
    for (const archive of [exported, originalsFirst]) {
      const roundTrip = createSink()
      await history.importArchive(file(archive), roundTrip.sink)
      assert.deepEqual(roundTrip.sessions, capture.sessions)
      assert.deepEqual([...roundTrip.types], [...capture.types])
      assert.equal(roundTrip.typeUpdates, 1)
      assert.equal(roundTrip.events.filter((event) => event.startsWith('file:')).length, 2)
    }
  }
})

test('共享 ID 的原件副本内容不一致时失败，不能覆盖首次上传或完成导入', async () => {
  const sessions = [sharedSession('conflict-a'), sharedSession('conflict-b')]
  const { manifest, index, conversations, originals } = sharedEntries(sessions)
  for (const changeSize of [false, true]) {
    const changed = new Uint8Array(await sharedImage.arrayBuffer())
    changed[changed.length - 1] ^= 1
    const conflict = {
      ...originals[2],
      blob: new Blob(changeSize ? [changed, new Uint8Array([0])] : [changed]),
    }
    for (const beforeSessions of [false, true]) {
      const data = [originals[0], originals[1], conflict, originals[3]]
      const entries = beforeSessions
        ? [manifest, ...data, index, ...conversations]
        : [manifest, index, ...conversations, ...data]
      const capture = createSink()
      await assert.rejects(
        history.importArchive(file(await history.writeArchive(entries)), capture.sink),
        /附件数据|attachment data/i
      )
      assert.equal(capture.events.filter((event) => event === 'file:image-1').length, 1)
      assert.deepEqual(
        await capture.files.get('image-1').arrayBuffer(),
        await sharedImage.arrayBuffer()
      )
      assert.equal(capture.types, undefined)
    }
  }
})

test('共享附件的某会话原件缺失仍保留引用，导出时为两个会话写入一致原件', async () => {
  const sessions = [sharedSession('missing-copy-a'), sharedSession('missing-copy-b')]
  const { manifest, index, conversations, originals } = sharedEntries(sessions)
  const capture = createSink()
  await history.importArchive(
    file(
      await history.writeArchive([manifest, originals[0], originals[1], index, ...conversations])
    ),
    capture.sink
  )
  assert.equal(capture.sessions.length, 2)
  assert.equal(capture.files.size, 2)
  const exported = await history.exportArchive(capture.sessions, async (id) =>
    capture.files.get(id)
  )
  const roundTrip = createSink()
  await history.importArchive(file(exported), roundTrip.sink)
  assert.deepEqual(roundTrip.sessions, capture.sessions)
  assert.equal(roundTrip.files.size, 2)
})

test('导出原件读取失败如实传递，缺失原件只保留元信息', async () => {
  const session = history.toLocalSession(sharedSession('loader-session')).session
  const failure = new Error('导出账号已改变')
  await assert.rejects(
    history.exportArchive([session], async () => {
      throw failure
    }),
    (error) => error === failure
  )
  const capture = createSink()
  const archive = await history.exportArchive([session], async () => undefined)
  await history.importArchive(file(archive), capture.sink)
  assert.equal(capture.files.size, 0)
  assert.deepEqual(capture.sessions[0], session)
})

test('共享文档分块校验覆盖全部字节，后续分块的同长度修改也会失败', async () => {
  const sessions = [sharedSession('large-copy-a'), sharedSession('large-copy-b')]
  const data = new Uint8Array(256 * 1024 + 17).fill(0x61)
  data.set(new TextEncoder().encode('%PDF-1.7\n'))
  for (const session of sessions) {
    for (const message of session.messages) {
      for (const fragment of message.fragments) {
        if (fragment.type === 'FILE') {
          for (const attachment of fragment.files) {
            if (attachment.id === 'document-1') {
              attachment.file_size = data.length
            }
          }
        }
      }
    }
  }
  const { manifest, index, conversations, originals } = sharedEntries(sessions)
  for (const conflict of [false, true]) {
    const changed = data.slice()
    if (conflict) {
      changed[changed.length - 1] ^= 1
    }
    const entries = [
      manifest,
      { ...originals[1], blob: new Blob([data]) },
      ...conversations,
      { ...originals[3], blob: new Blob([changed]) },
      originals[0],
      originals[2],
      index,
    ]
    const capture = createSink()
    const importing = history.importArchive(file(await history.writeArchive(entries)), capture.sink)
    if (conflict) {
      await assert.rejects(importing, /附件数据|attachment data/i)
      assert.equal(capture.types, undefined)
    } else {
      await importing
      assert.equal(capture.files.size, 2)
      assert.equal(capture.files.get('document-1').type, 'application/pdf')
      assert.deepEqual(await capture.files.get('document-1').arrayBuffer(), data.buffer)
    }
    assert.equal(capture.events.filter((event) => event === 'file:document-1').length, 1)
  }
})

test('未引用的共享副本与 CRC 损坏均不能作为成功导入', async () => {
  const sessions = [sharedSession('validated-copy-a'), sharedSession('validated-copy-b')]
  const { manifest, index, conversations, originals } = sharedEntries(sessions)
  const orphan = {
    name: history.filePath('unreferenced-session', 'image-1', 'orphan.png'),
    blob: sharedImage,
  }
  const capture = createSink()
  await assert.rejects(
    history.importArchive(
      file(await history.writeArchive([manifest, ...originals, orphan, index, ...conversations])),
      capture.sink
    ),
    /不完整|incomplete/i
  )
  assert.equal(capture.types, undefined)
  assert.equal(capture.files.size, 2)

  const valid = await history.writeArchive([manifest, ...conversations, index, ...originals])
  const bytes = new Uint8Array(await valid.arrayBuffer())
  // 修改共享副本的数据，不改目录 CRC，检查去重路径仍然读取并校验全部副本。
  const originalBytes = new Uint8Array(await sharedImage.arrayBuffer())
  const firstImage = Buffer.from(bytes).indexOf(originalBytes)
  const secondImage = Buffer.from(bytes).indexOf(originalBytes, firstImage + originalBytes.length)
  assert.ok(firstImage >= 0 && secondImage > firstImage)
  bytes[secondImage + originalBytes.length - 1] ^= 1
  const corrupted = createSink()
  await assert.rejects(history.importArchive(file(bytes), corrupted.sink), /不完整|incomplete/i)
  assert.equal(corrupted.types, undefined)
  assert.equal(corrupted.events.filter((event) => event === 'file:image-1').length, 1)
})

test('读取 ZIP64 目录、64 位大小与偏移', async () => {
  const archive = createZip64([
    { name: history.MANIFEST_PATH, data: JSON.stringify({ export_format_version: 3 }) },
    { name: history.INDEX_PATH, data: '[]' },
  ])
  const entries = []
  for await (const entry of history.readArchive(file(archive))) {
    entries.push({ path: entry.path, text: await (await history.readEntry(entry)).text() })
  }
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [history.MANIFEST_PATH, history.INDEX_PATH]
  )
  assert.deepEqual(JSON.parse(entries[1].text), [])

  const capture = createSink()
  await history.importArchive(file(archive), capture.sink)
  assert.equal(capture.sessions.length, 0)
  assert.equal(capture.types.size, 0)
})
