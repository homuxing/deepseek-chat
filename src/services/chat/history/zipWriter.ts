const ZIP32_MAX = 0xffffffff
const ZIP32_COUNT_MAX = 0xffff

export class ArchiveLimitError extends Error {
  constructor() {
    super('History archive exceeds the JavaScript file size range')
    this.name = 'ArchiveLimitError'
  }
}

const invalid = (): never => {
  throw new Error('Invalid history archive entry')
}

const safeNumber = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArchiveLimitError()
  }
  return value
}

/** 与读取端保持相同路径规则，成品必须能再次导入。 */
const entryName = (name: string) => {
  const normalized = name.normalize('NFC')
  if (
    !normalized ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    invalid()
  }
  const bytes = new TextEncoder().encode(normalized)
  if (bytes.length > 0xffff) {
    throw new ArchiveLimitError()
  }
  // 拒绝孤立代理项，避免编码时替换成 U+FFFD 后改变附件的关联路径。
  if (new TextDecoder().decode(bytes) !== normalized) {
    invalid()
  }
  return { name: normalized, bytes }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

type Record = {
  name: Uint8Array
  crc: number
  size: number
  offset: number
}

/**
 * 以 STORE + data descriptor 写入 ZIP。大小或偏移达到 ZIP32 字段上限时自动改用 ZIP64，
 * 条目数和中央目录大小也不再受 65535 / 4 GiB 限制。
 */
export const writeArchive = async (entries: { name: string; blob: Blob }[]): Promise<Blob> => {
  const names = new Set<string>()
  const prepared = entries.map(({ name, blob }) => {
    const normalized = entryName(name)
    if (names.has(normalized.name)) {
      invalid()
    }
    names.add(normalized.name)
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) {
      throw new ArchiveLimitError()
    }
    return { name: normalized.name, bytes: normalized.bytes, blob, size: blob.size }
  })

  const parts: BlobPart[] = []
  const records: Record[] = []
  let fileOffset = 0
  const append = (part: Uint8Array<ArrayBuffer> | Blob) => {
    parts.push(part)
    fileOffset = safeNumber(fileOffset + (part instanceof Blob ? part.size : part.byteLength))
  }

  for (const entry of prepared) {
    const offset = fileOffset
    const zip64Data = entry.size >= ZIP32_MAX
    const extraLength = zip64Data ? 20 : 0
    const local = new Uint8Array(30 + entry.bytes.length + extraLength)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, zip64Data ? 45 : 20, true)
    // UTF-8 文件名 + data descriptor。
    view.setUint16(6, 0x808, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0x21, true)
    view.setUint32(18, zip64Data ? ZIP32_MAX : 0, true)
    view.setUint32(22, zip64Data ? ZIP32_MAX : 0, true)
    view.setUint16(26, entry.bytes.length, true)
    view.setUint16(28, extraLength, true)
    local.set(entry.bytes, 30)
    if (zip64Data) {
      const extra = local.subarray(30 + entry.bytes.length)
      const extraView = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
      extraView.setUint16(0, 0x0001, true)
      extraView.setUint16(2, 16, true)
      // 最终大小由 64 位 data descriptor 提供。
      extraView.setBigUint64(4, 0n, true)
      extraView.setBigUint64(12, 0n, true)
    }
    append(local)

    let written = 0
    let crc = 0xffffffff
    const reader = entry.blob.stream().getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        written = safeNumber(written + value.byteLength)
        if (written > entry.size) {
          invalid()
        }
        for (const byte of value) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
        }
        append(new Blob([value as Uint8Array<ArrayBuffer>]))
      }
      if (written !== entry.size) {
        invalid()
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }

    const finalCrc = (crc ^ 0xffffffff) >>> 0
    const descriptor = new Uint8Array(zip64Data ? 24 : 16)
    const descriptorView = new DataView(descriptor.buffer)
    descriptorView.setUint32(0, 0x08074b50, true)
    descriptorView.setUint32(4, finalCrc, true)
    if (zip64Data) {
      descriptorView.setBigUint64(8, BigInt(entry.size), true)
      descriptorView.setBigUint64(16, BigInt(entry.size), true)
    } else {
      descriptorView.setUint32(8, entry.size, true)
      descriptorView.setUint32(12, entry.size, true)
    }
    append(descriptor)
    records.push({
      name: entry.bytes,
      crc: finalCrc,
      size: entry.size,
      offset,
    })
  }

  const directoryOffset = fileOffset
  for (const record of records) {
    const zip64Size = record.size >= ZIP32_MAX
    const zip64Offset = record.offset >= ZIP32_MAX
    const zip64ValuesLength = (zip64Size ? 16 : 0) + (zip64Offset ? 8 : 0)
    const extraLength = zip64ValuesLength === 0 ? 0 : 4 + zip64ValuesLength
    const directory = new Uint8Array(46 + record.name.length + extraLength)
    const view = new DataView(directory.buffer)
    view.setUint32(0, 0x02014b50, true)
    // Unix + ZIP 4.5，外部文件权限 0644。
    view.setUint16(4, 0x032d, true)
    view.setUint16(6, zip64Size || zip64Offset ? 45 : 20, true)
    view.setUint16(8, 0x808, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0, true)
    view.setUint16(14, 0x21, true)
    view.setUint32(16, record.crc, true)
    view.setUint32(20, zip64Size ? ZIP32_MAX : record.size, true)
    view.setUint32(24, zip64Size ? ZIP32_MAX : record.size, true)
    view.setUint16(28, record.name.length, true)
    view.setUint16(30, extraLength, true)
    view.setUint32(38, 0x81a40000, true)
    view.setUint32(42, zip64Offset ? ZIP32_MAX : record.offset, true)
    directory.set(record.name, 46)
    if (extraLength > 0) {
      const extra = directory.subarray(46 + record.name.length)
      const extraView = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
      extraView.setUint16(0, 0x0001, true)
      extraView.setUint16(2, zip64ValuesLength, true)
      let cursor = 4
      if (zip64Size) {
        extraView.setBigUint64(cursor, BigInt(record.size), true)
        extraView.setBigUint64(cursor + 8, BigInt(record.size), true)
        cursor += 16
      }
      if (zip64Offset) {
        extraView.setBigUint64(cursor, BigInt(record.offset), true)
      }
    }
    append(directory)
  }
  const directorySize = fileOffset - directoryOffset

  const zip64 =
    records.length >= ZIP32_COUNT_MAX || directoryOffset >= ZIP32_MAX || directorySize >= ZIP32_MAX
  if (zip64) {
    const recordOffset = fileOffset
    const record = new Uint8Array(56)
    const view = new DataView(record.buffer)
    view.setUint32(0, 0x06064b50, true)
    view.setBigUint64(4, 44n, true)
    view.setUint16(12, 45, true)
    view.setUint16(14, 45, true)
    view.setBigUint64(24, BigInt(records.length), true)
    view.setBigUint64(32, BigInt(records.length), true)
    view.setBigUint64(40, BigInt(directorySize), true)
    view.setBigUint64(48, BigInt(directoryOffset), true)
    append(record)

    const locator = new Uint8Array(20)
    const locatorView = new DataView(locator.buffer)
    locatorView.setUint32(0, 0x07064b50, true)
    locatorView.setBigUint64(8, BigInt(recordOffset), true)
    locatorView.setUint32(16, 1, true)
    append(locator)
  }

  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, zip64 ? ZIP32_COUNT_MAX : records.length, true)
  endView.setUint16(10, zip64 ? ZIP32_COUNT_MAX : records.length, true)
  endView.setUint32(12, zip64 ? ZIP32_MAX : directorySize, true)
  endView.setUint32(16, zip64 ? ZIP32_MAX : directoryOffset, true)
  append(end)
  return new Blob(parts, { type: 'application/zip' })
}
