import { Inflate } from 'fflate'

const READ_CHUNK_BYTES = 256 * 1024
// 控制每轮同步解压的工作量；输出交给调用方保存后才继续读取。
const INFLATE_CHUNK_BYTES = 8 * 1024
const ZIP32_MAX = 0xffffffff
const ZIP32_COUNT_MAX = 0xffff
const EOCD_SIZE = 22
const EOCD64_LOCATOR_SIZE = 20

/** ZIP 结构损坏或使用了不支持的特性 */
export class ArchiveError extends Error {
  constructor() {
    super('Invalid or unsupported history archive')
    this.name = 'ArchiveError'
  }
}

const invalid = (): never => {
  throw new ArchiveError()
}

/** 本地文件头签名 PK\x03\x04，用于在解析前区分 ZIP 与其他文件。 */
export const isZipFile = async (file: File) => {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return bytes.length === 4 && bytes.every((byte, index) => byte === [0x50, 0x4b, 3, 4][index])
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const uint64 = (view: DataView, offset: number) => {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid()
  }
  return Number(value)
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const readBytes = async (file: File, start: number, length: number) => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > file.size
  ) {
    invalid()
  }
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
  if (bytes.length !== length) {
    invalid()
  }
  return bytes
}

type ExtraField = { id: number; data: Uint8Array }

const extras = (bytes: Uint8Array): ExtraField[] => {
  const view = viewOf(bytes)
  const fields: ExtraField[] = []
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      invalid()
    }
    const id = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    const end = offset + 4 + size
    if (end > bytes.length) {
      invalid()
    }
    fields.push({ id, data: bytes.subarray(offset + 4, end) })
    offset = end
  }
  return fields
}

type Zip64Needs = {
  size: boolean
  compressedSize: boolean
  offset: boolean
  disk: boolean
}

const zip64Values = (fields: ExtraField[], needs: Zip64Needs) => {
  const entries = fields.filter((field) => field.id === 0x0001)
  if (entries.length > 1) {
    invalid()
  }
  const data = entries[0]?.data
  const count =
    Number(needs.size) + Number(needs.compressedSize) + Number(needs.offset) + Number(needs.disk)
  if (count === 0) {
    return { size: 0, compressedSize: 0, offset: 0, disk: 0 }
  }
  const required =
    (Number(needs.size) + Number(needs.compressedSize) + Number(needs.offset)) * 8 +
    Number(needs.disk) * 4
  if (!data || data.length < required) {
    invalid()
  }
  const view = viewOf(data)
  let offset = 0
  const take = () => {
    const value = uint64(view, offset)
    offset += 8
    return value
  }
  const result = {
    size: needs.size ? take() : 0,
    compressedSize: needs.compressedSize ? take() : 0,
    offset: needs.offset ? take() : 0,
    disk: 0,
  }
  if (needs.disk) {
    // ZIP64 的 disk start 是 4 字节，其它字段均为 8 字节。
    if (offset + 4 > data.length) {
      invalid()
    }
    result.disk = view.getUint32(offset, true)
  }
  return result
}

const decodePath = (bytes: Uint8Array, flags: number) => {
  // 非 UTF-8 编码的 ZIP 文件名仅接受 ASCII，确保附件路径解码准确。
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    invalid()
  }
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    invalid()
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    invalid()
  }
  return path
}

type Entry = {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
  zip64: boolean
}

type Directory = {
  entries: Entry[]
  offset: number
}

const readDirectory = async (file: File): Promise<Directory> => {
  if (file.size < EOCD_SIZE) {
    invalid()
  }
  const tailStart = Math.max(0, file.size - EOCD_SIZE - ZIP32_COUNT_MAX)
  const tail = await readBytes(file, tailStart, file.size - tailStart)
  const tailView = viewOf(tail)
  let end = tail.length - EOCD_SIZE
  while (
    end >= 0 &&
    (tailView.getUint32(end, true) !== 0x06054b50 ||
      end + EOCD_SIZE + tailView.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (
    end < 0 ||
    tailView.getUint16(end + 4, true) !== 0 ||
    tailView.getUint16(end + 6, true) !== 0
  ) {
    invalid()
  }

  const diskCount = tailView.getUint16(end + 8, true)
  const totalCount = tailView.getUint16(end + 10, true)
  const directorySize = tailView.getUint32(end + 12, true)
  const directoryOffset = tailView.getUint32(end + 16, true)
  if (diskCount !== totalCount && diskCount !== ZIP32_COUNT_MAX) {
    invalid()
  }
  const usesZip64 =
    diskCount === ZIP32_COUNT_MAX ||
    totalCount === ZIP32_COUNT_MAX ||
    directorySize === ZIP32_MAX ||
    directoryOffset === ZIP32_MAX

  let count = totalCount
  let size = directorySize
  let offset = directoryOffset
  let directoryEnd = tailStart + end
  if (usesZip64) {
    const locatorStart = directoryEnd - EOCD64_LOCATOR_SIZE
    if (locatorStart < 0) {
      invalid()
    }
    const locator = viewOf(await readBytes(file, locatorStart, EOCD64_LOCATOR_SIZE))
    if (
      locator.getUint32(0, true) !== 0x07064b50 ||
      locator.getUint32(4, true) !== 0 ||
      locator.getUint32(16, true) !== 1
    ) {
      invalid()
    }
    const recordOffset = uint64(locator, 8)
    if (recordOffset + 12 > locatorStart) {
      invalid()
    }
    const recordHeader = viewOf(await readBytes(file, recordOffset, 12))
    const recordSize = uint64(recordHeader, 4)
    const recordEnd = recordOffset + 12 + recordSize
    if (
      recordHeader.getUint32(0, true) !== 0x06064b50 ||
      recordSize < 44 ||
      recordEnd !== locatorStart
    ) {
      invalid()
    }
    const record = viewOf(await readBytes(file, recordOffset, 12 + recordSize))
    const recordDisk = record.getUint32(16, true)
    const directoryDisk = record.getUint32(20, true)
    const entriesOnDisk64 = uint64(record, 24)
    const totalCount64 = uint64(record, 32)
    const size64 = uint64(record, 40)
    const offset64 = uint64(record, 48)
    if (
      recordDisk !== 0 ||
      directoryDisk !== 0 ||
      entriesOnDisk64 !== totalCount64 ||
      (diskCount !== ZIP32_COUNT_MAX && totalCount64 !== diskCount) ||
      (totalCount !== ZIP32_COUNT_MAX && totalCount !== totalCount64) ||
      (directorySize !== ZIP32_MAX && directorySize !== size64) ||
      (directoryOffset !== ZIP32_MAX && directoryOffset !== offset64)
    ) {
      invalid()
    }
    count = totalCount64
    size = size64
    offset = offset64
    directoryEnd = recordOffset
  }
  if (offset + size !== directoryEnd) {
    invalid()
  }

  const entries: Entry[] = []
  const paths = new Set<string>()
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size) {
      invalid()
    }
    const view = viewOf(await readBytes(file, offset + cursor, 46))
    if (view.getUint32(0, true) !== 0x02014b50) {
      invalid()
    }
    const madeBy = view.getUint16(4, true)
    const flags = view.getUint16(8, true)
    const method = view.getUint16(10, true)
    const compressedSize32 = view.getUint32(20, true)
    const size32 = view.getUint32(24, true)
    const nameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const commentLength = view.getUint16(32, true)
    const diskStart32 = view.getUint16(34, true)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    const offset32 = view.getUint32(42, true)
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      next > size ||
      (method === 0 && compressedSize32 !== size32 && compressedSize32 !== ZIP32_MAX)
    ) {
      invalid()
    }
    const name = await readBytes(file, offset + cursor + 46, nameLength)
    const extraBytes = await readBytes(file, offset + cursor + 46 + nameLength, extraLength)
    const fields = extras(extraBytes)
    const zip64Needs = {
      size: size32 === ZIP32_MAX,
      compressedSize: compressedSize32 === ZIP32_MAX,
      offset: offset32 === ZIP32_MAX,
      disk: diskStart32 === ZIP32_COUNT_MAX,
    }
    const zip64 = zip64Values(fields, zip64Needs)
    const entrySize = zip64Needs.size ? zip64.size : size32
    const compressedSize = zip64Needs.compressedSize ? zip64.compressedSize : compressedSize32
    const entryOffset = zip64Needs.offset ? zip64.offset : offset32
    const diskStart = zip64Needs.disk ? zip64.disk : diskStart32
    const external = view.getUint32(38, true)
    const unixType = madeBy >>> 8 === 3 ? (external >>> 16) & 0xf000 : 0
    if (
      diskStart !== 0 ||
      (method === 0 && compressedSize !== entrySize) ||
      entryOffset >= offset ||
      unixType === 0xa000
    ) {
      invalid()
    }
    const path = decodePath(name, flags)
    // 目录和同名文件也不能互相覆盖。
    const identity = path.endsWith('/') ? path.slice(0, -1) : path
    if (
      paths.has(identity) ||
      (path.endsWith('/') && entrySize !== 0) ||
      (unixType !== 0 && (unixType === 0x4000) !== path.endsWith('/'))
    ) {
      invalid()
    }
    paths.add(identity)
    entries.push({
      path,
      name,
      flags,
      method,
      crc: view.getUint32(16, true),
      compressedSize,
      size: entrySize,
      offset: entryOffset,
      // data descriptor 的宽度只由 64 位大小决定；仅偏移超过 ZIP32 时可继续使用 32 位描述符。
      zip64: zip64Needs.size || zip64Needs.compressedSize,
    })
    cursor = next
  }
  if (cursor !== size) {
    invalid()
  }
  entries.sort((a, b) => a.offset - b.offset)
  if (entries.some((entry, index) => index > 0 && entry.offset === entries[index - 1]?.offset)) {
    invalid()
  }
  return { entries, offset }
}

const readEntryOffset = async (file: File, entry: Entry, boundary: number) => {
  if (entry.offset + 30 > boundary) {
    invalid()
  }
  const view = viewOf(await readBytes(file, entry.offset, 30))
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const metadataEnd = entry.offset + 30 + nameLength + extraLength
  const start = metadataEnd
  const end = start + entry.compressedSize
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== entry.flags ||
    view.getUint16(8, true) !== entry.method ||
    nameLength !== entry.name.length ||
    end > boundary
  ) {
    invalid()
  }
  const metadata = await readBytes(file, entry.offset + 30, nameLength + extraLength)
  if (entry.name.some((byte, index) => byte !== metadata[index])) {
    invalid()
  }
  const fields = extras(metadata.subarray(nameLength))
  const localSize32 = view.getUint32(22, true)
  const localCompressed32 = view.getUint32(18, true)
  const localZip64 = zip64Values(fields, {
    size: localSize32 === ZIP32_MAX,
    compressedSize: localCompressed32 === ZIP32_MAX,
    offset: false,
    disk: false,
  })
  const localSize = localSize32 === ZIP32_MAX ? localZip64.size : localSize32
  const localCompressed =
    localCompressed32 === ZIP32_MAX ? localZip64.compressedSize : localCompressed32

  if (entry.flags & 8) {
    if (
      ![0, entry.crc].includes(view.getUint32(14, true)) ||
      ![0, entry.compressedSize].includes(localCompressed) ||
      ![0, entry.size].includes(localSize)
    ) {
      invalid()
    }
  } else if (
    view.getUint32(14, true) !== entry.crc ||
    localCompressed !== entry.compressedSize ||
    localSize !== entry.size
  ) {
    invalid()
  }

  if (entry.flags & 8) {
    const available = boundary - end
    if (available < 12) {
      invalid()
    }
    const descriptorBytes = await readBytes(file, end, Math.min(24, available))
    const descriptor = viewOf(descriptorBytes)
    const shift = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0
    const width = entry.zip64 ? 8 : 4
    if (shift + 4 + width * 2 > descriptorBytes.length) {
      invalid()
    }
    const descriptorSize =
      width === 8 ? uint64(descriptor, shift + 4) : descriptor.getUint32(shift + 4, true)
    const descriptorUncompressed =
      width === 8 ? uint64(descriptor, shift + 12) : descriptor.getUint32(shift + 8, true)
    if (
      descriptor.getUint32(shift, true) !== entry.crc ||
      descriptorSize !== entry.compressedSize ||
      descriptorUncompressed !== entry.size
    ) {
      invalid()
    }
  }
  return start
}

export type ArchiveEntry = {
  path: string
  size: number
  stream: AsyncIterable<Uint8Array>
}

/**
 * 按条目在文件中的物理顺序逐条、逐块解压，跳过目录条目。
 * 调用方必须消费完当前条目的数据，再请求下一个条目。
 */
export async function* readArchive(file: File): AsyncGenerator<ArchiveEntry> {
  const directory = await readDirectory(file)
  for (const [index, entry] of directory.entries.entries()) {
    const boundary = directory.entries[index + 1]?.offset ?? directory.offset
    const start = await readEntryOffset(file, entry, boundary)
    if (entry.path.endsWith('/')) {
      continue
    }
    let completed = false
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      let written = 0
      let crc = 0xffffffff
      const pending: Uint8Array[] = []
      const append = (chunk: Uint8Array) => {
        written += chunk.length
        if (written > entry.size) {
          invalid()
        }
        for (const byte of chunk) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
        }
        if (chunk.length) {
          pending.push(chunk)
        }
      }
      const inflate = entry.method === 8 ? new Inflate(append) : null
      for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
        const chunk = await readBytes(
          file,
          start + offset,
          Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
        )
        if (!inflate) {
          append(chunk)
          yield* pending.splice(0)
          continue
        }
        for (let cursor = 0; cursor < chunk.length; cursor += INFLATE_CHUNK_BYTES) {
          const chunkEnd = Math.min(cursor + INFLATE_CHUNK_BYTES, chunk.length)
          inflate.push(chunk.subarray(cursor, chunkEnd), offset + chunkEnd === entry.compressedSize)
          // yield 暂停解压，等待调用方完成异步写入；不缓存整个条目。
          yield* pending.splice(0)
        }
      }
      if (inflate && entry.compressedSize === 0) {
        inflate.push(new Uint8Array(), true)
        yield* pending.splice(0)
      }
      if (written !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
        invalid()
      }
      completed = true
    }
    yield { path: entry.path, size: entry.size, stream: stream() }
    if (!completed) {
      invalid()
    }
  }
}

/** 读出整个条目：会话 JSON 需要完整解析，原件需要生成可上传的 Blob。 */
export const readEntry = async (entry: ArchiveEntry): Promise<Blob> => {
  const parts: Blob[] = []
  for await (const chunk of entry.stream) {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]))
  }
  return new Blob(parts)
}

/** 不需要的条目也要读完，以校验大小与 CRC。 */
export const skipEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据。
  }
}
