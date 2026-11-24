import type { Session } from '../chatTypes.js'
import { BackupError, fail } from './errors.js'
import {
  INDEX_PATH,
  MANIFEST_PATH,
  USER_PATH,
  parseOriginalPath,
  parseSessionPath,
} from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  listArchiveEntries,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

export type ArchiveImportSink = {
  addSession(session: Session): Promise<void>
  addSessions?(sessions: Session[]): Promise<void>
  saveFiles(files: { id: string; blob: Blob }[]): Promise<void>
  updateFileTypes(types: ReadonlyMap<string, string>): Promise<void>
}

export type ArchiveImportOptions = {
  concurrency?: number
  signal?: AbortSignal
  onError?: (error: unknown) => void
  sessionBatchSize?: number
  sessionBatchBytes?: number
  yieldToUI?: boolean
}

/** 并发任务有界；首次失败立即停止新增任务，退出前等待已有写入全部结束。 */
const createImportTasks = (options: ArchiveImportOptions) => {
  const concurrency = options.concurrency ?? 1
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('导入并发数必须是正整数')
  }
  const active = new Set<Promise<void>>()
  let failed = false
  let failure: unknown
  const check = () => {
    if (failed) {
      throw failure
    }
    options.signal?.throwIfAborted()
  }
  return {
    async ready() {
      check()
      while (active.size >= concurrency) {
        await Promise.race(active)
        check()
      }
    },
    add(run: () => Promise<void>) {
      check()
      const task = run()
        .catch((error: unknown) => {
          if (!failed) {
            failed = true
            failure = error
            options.onError?.(error)
          }
        })
        .finally(() => active.delete(task))
      active.add(task)
    },
    async finish() {
      await Promise.all(active)
      check()
    },
    async drain() {
      await Promise.all(active)
    },
  }
}

const startsWith = (bytes: Uint8Array, ...prefix: number[]) =>
  prefix.every((byte, index) => bytes[index] === byte)

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  new TextDecoder('ascii').decode(bytes.subarray(start, end))

const extensionTypes = new Map<string, string>([
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['gif', 'image/gif'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['ico', 'image/x-icon'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['webp', 'image/webp'],
  ['csv', 'text/csv'],
  ['htm', 'text/html'],
  ['html', 'text/html'],
  ['json', 'application/json'],
  ['md', 'text/markdown'],
  ['pdf', 'application/pdf'],
  ['rtf', 'application/rtf'],
  ['txt', 'text/plain'],
  ['xml', 'application/xml'],
  ['7z', 'application/x-7z-compressed'],
  ['gz', 'application/gzip'],
  ['rar', 'application/vnd.rar'],
  ['tar', 'application/x-tar'],
  ['zip', 'application/zip'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['m4a', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
  ['oga', 'audio/ogg'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['avi', 'video/x-msvideo'],
  ['mov', 'video/quicktime'],
  ['mp4', 'video/mp4'],
  ['mpeg', 'video/mpeg'],
  ['mpg', 'video/mpeg'],
  ['webm', 'video/webm'],
])

/** 先按内容签名识别；容器类格式再结合文件名区分具体文档类型。 */
const detectFileType = async (blob: Blob, fileName: string): Promise<string> => {
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
  const header = ascii(bytes, 0, Math.min(bytes.length, 16))
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase()
  let signature = ''
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) {
    signature = 'image/jpeg'
  } else if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    signature = 'image/png'
  } else if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    signature = 'image/gif'
  } else if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    signature = 'image/webp'
  } else if (startsWith(bytes, 0x42, 0x4d)) {
    signature = 'image/bmp'
  } else if (startsWith(bytes, 0x49, 0x49, 0x2a, 0) || startsWith(bytes, 0x4d, 0x4d, 0, 0x2a)) {
    signature = 'image/tiff'
  } else if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    signature = 'image/avif'
  } else if (header.startsWith('%PDF-')) {
    signature = 'application/pdf'
  } else if (startsWith(bytes, 0x50, 0x4b, 3, 4) || startsWith(bytes, 0x50, 0x4b, 5, 6)) {
    signature = 'application/zip'
  } else if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    signature = 'application/x-ole-storage'
  } else if (startsWith(bytes, 0x1f, 0x8b)) {
    signature = 'application/gzip'
  } else if (startsWith(bytes, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) {
    signature = 'application/x-7z-compressed'
  } else if (header.startsWith('Rar!')) {
    signature = 'application/vnd.rar'
  } else if (header.startsWith('ID3') || startsWith(bytes, 0xff, 0xfb)) {
    signature = 'audio/mpeg'
  } else if (header.startsWith('OggS')) {
    signature = 'audio/ogg'
  } else if (header.startsWith('fLaC')) {
    signature = 'audio/flac'
  } else if (header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE') {
    signature = 'audio/wav'
  } else if (header.startsWith('RIFF') && header.slice(8, 12) === 'AVI ') {
    signature = 'video/x-msvideo'
  }

  const byExtension = extension === undefined ? undefined : extensionTypes.get(extension)
  // ZIP 容器可能是 docx、xlsx 或 pptx，扩展名比通用容器签名更具体。
  if (
    byExtension &&
    (signature === '' ||
      signature === 'application/zip' ||
      signature === 'application/x-ole-storage')
  ) {
    return byExtension
  }
  return signature || byExtension || blob.type || 'application/octet-stream'
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/** 分块计算内容指纹；共享原件只保留固定长度摘要，避免缓存副本或整文件 ArrayBuffer。 */
const fingerprint = async (blob: Blob): Promise<string> => {
  const chunkSize = 256 * 1024
  let digest = new Uint8Array(32)
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer())
    const input = new Uint8Array(digest.length + chunk.length)
    input.set(digest)
    input.set(chunk, digest.length)
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  }
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本，返回目录中的真实总数。
 */
export const checkArchiveFormat = async (
  file: File
): Promise<{ totalSessions: number; totalFiles: number }> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      checkManifest(await readJson(entry))
      const entries = await listArchiveEntries(file)
      const files = new Set<string>()
      let totalSessions = 0
      for (const { path } of entries) {
        if (parseSessionPath(path) !== null) {
          totalSessions++
        }
        const original = parseOriginalPath(path)
        if (original) {
          files.add(original.fileId)
        }
      }
      return { totalSessions, totalFiles: files.size }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  return fail('backupUnrecognized')
}

/**
 * 按条目读取归档并交给 sink，原件只在处理时短暂读成 Blob。
 * 解析器只保留会话 ID、索引计数和原件路径映射，不暂存全部正文。
 * manifest 必须位于首位；user、index、会话和原件可在其后交错排列。
 */
export const importArchive = async (
  file: File,
  sink: ArchiveImportSink,
  options: ArchiveImportOptions = {}
): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  const sessionMessageCounts = new Map<string, number>()
  const references = new Map<string, string>()
  const pathsBySession = new Map<string, Map<string, string>>()
  const originalsById = new Map<string, { size: number; fingerprint: string }>()
  const archivePaths = new Set<string>()
  const types = new Map<string, string>()
  let manifestSeen = false
  let userSeen = false
  let index: Map<string, number> | undefined
  const tasks = createImportTasks(options)
  let lastYield = performance.now()
  const batchSize = options.sessionBatchSize ?? 16
  const batchBytes = options.sessionBatchBytes ?? 256 * 1024
  const encoder = new TextEncoder()
  let pendingSessions: Session[] = []
  let pendingBytes = 15
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    !Number.isSafeInteger(batchBytes) ||
    batchBytes < 15
  ) {
    throw new RangeError('导入批次大小无效')
  }
  const flushSessions = async () => {
    if (!pendingSessions.length) {
      return
    }
    await tasks.ready()
    const sessions = pendingSessions
    pendingSessions = []
    pendingBytes = 15
    const addSessions = sink.addSessions
    if (!addSessions) {
      throw new Error('导入批次处理器缺失')
    }
    tasks.add(() => addSessions(sessions))
  }
  const scheduleSession = async (session: Session) => {
    if (!sink.addSessions) {
      tasks.add(() => sink.addSession(session))
      return
    }
    // 按 UTF-8 字节控制请求大小，大会话独立上传，待发送批次最多保留一个。
    const bytes = encoder.encode(JSON.stringify(session)).byteLength + 1
    if (pendingBytes + bytes > batchBytes || pendingSessions.length >= batchSize) {
      await flushSessions()
    }
    if (bytes + 15 > batchBytes) {
      await tasks.ready()
      tasks.add(() => sink.addSession(session))
      return
    }
    pendingSessions.push(session)
    pendingBytes += bytes
    if (pendingSessions.length >= batchSize) {
      await flushSessions()
    }
  }

  const registerPath = (path: string, sessionId: string, id: string) => {
    let paths = pathsBySession.get(sessionId)
    if (!paths) {
      paths = new Map()
      pathsBySession.set(sessionId, paths)
    }
    // 同一文件可在不同会话目录出现；同一会话内仍须保持唯一原件路径。
    if ((references.get(path) ?? id) !== id || (paths.get(id) ?? path) !== path) {
      fail('backupInvalidFiles')
    }
    paths.set(id, path)
  }

  const saveOriginal = async (
    entry: ArchiveEntry,
    original: NonNullable<ReturnType<typeof parseOriginalPath>>
  ) => {
    // 原件可早于会话，先登记路径；归档结束时再检查该路径确实被会话引用。
    registerPath(entry.path, original.sessionId, original.fileId)
    archivePaths.add(entry.path)
    const blob = await readEntry(entry)
    const previous = originalsById.get(original.fileId)
    if (previous && previous.size !== blob.size) {
      fail('backupInvalidFiles')
    }
    const contentFingerprint = await fingerprint(blob)
    if (previous) {
      if (previous.fingerprint !== contentFingerprint) {
        fail('backupInvalidFiles')
      }
      // 各会话目录中的共享副本经过 CRC 和内容校验后，只上传一次。
      return
    }
    const type = await detectFileType(blob, original.fileName)
    // 在调度上传前登记指纹，后续共享副本即使早于上传完成也只保存一次。
    originalsById.set(original.fileId, { size: blob.size, fingerprint: contentFingerprint })
    types.set(original.fileId, type)
    tasks.add(() => sink.saveFiles([{ id: original.fileId, blob: new Blob([blob], { type }) }]))
  }

  try {
    for await (const entry of readArchive(file, options)) {
      await tasks.ready()
      // 定时交还浏览器事件循环，让进度和离开保护在连续解析小条目时也能更新。
      if (options.yieldToUI && performance.now() - lastYield >= 16) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        lastYield = performance.now()
      }
      const { path } = entry
      if (!manifestSeen) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifestSeen = true
        continue
      }

      const sessionId = parseSessionPath(path)
      const original = parseOriginalPath(path)
      if (path === MANIFEST_PATH) {
        fail('backupIncomplete')
      } else if (path === USER_PATH) {
        if (userSeen) {
          fail('backupIncomplete')
        }
        userSeen = true
        await skipEntry(entry)
      } else if (path === INDEX_PATH) {
        if (index !== undefined) {
          fail('backupIncomplete')
        }
        const entries = readSessionIndex(await readJson(entry))
        index = new Map()
        for (const item of entries) {
          if (index.has(item.id)) {
            fail('backupIncomplete')
          }
          index.set(item.id, item.message_count)
        }
      } else if (sessionId !== null) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        for (const [fileZipPath, id] of local.files) {
          registerPath(fileZipPath, sessionId, id)
          references.set(fileZipPath, id)
        }
        imported.add(sessionId)
        sessionMessageCounts.set(sessionId, local.session.messages.length)
        await scheduleSession(local.session)
      } else if (original !== null) {
        await flushSessions()
        await tasks.ready()
        await saveOriginal(entry, original)
      } else {
        fail('backupIncomplete')
      }
    }
    await flushSessions()
    await tasks.finish()
  } catch (error) {
    options.onError?.(error)
    await tasks.drain()
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }

  try {
    if (
      !manifestSeen ||
      !index ||
      index.size !== imported.size ||
      [...imported].some((id) => !index.has(id)) ||
      [...sessionMessageCounts].some(([id, count]) => index.get(id) !== count) ||
      [...archivePaths].some((path) => !references.has(path))
    ) {
      fail('backupIncomplete')
    }
    await sink.updateFileTypes(types)
  } catch (error) {
    options.onError?.(error)
    throw error
  }
}
