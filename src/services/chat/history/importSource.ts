import { BackupError } from './errors.js'

const sourceReadErrors = new Set(['NotFoundError', 'NotReadableError', 'SecurityError'])

/** 本地读取失败与归档内容错误分开处理，保留原始异常供诊断。 */
export const sourceReadError = (error: unknown): unknown => {
  if (error instanceof DOMException && sourceReadErrors.has(error.name)) {
    const failure = new BackupError('backupSourceUnavailable')
    failure.cause = error
    return failure
  }
  return error
}

/** 上传前取得完整副本，网络等待期间不再依赖用户选择的磁盘文件。 */
export const prepareImportSource = async (
  source: File,
  signal: AbortSignal,
  onProgress: (bytes: number) => void
): Promise<{ file: File; dispose(): Promise<void> }> => {
  signal.throwIfAborted()
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new BackupError('backupStorageUnavailable')
  }
  const directory = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle('history-imports', { create: true })
  const name = crypto.randomUUID()
  const handle = await directory.getFileHandle(name, { create: true })
  const dispose = () => directory.removeEntry(name)
  try {
    const reader = source.stream().getReader()
    let copied = 0
    let released = false
    const release = () => {
      if (!released) {
        released = true
        reader.releaseLock()
      }
    }
    // 单个流保持读取顺序，确认完整读取且副本关闭成功后才进入检查阶段。
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            if (copied !== source.size) {
              throw new BackupError('backupIncomplete')
            }
            controller.close()
            release()
            return
          }
          copied += next.value.byteLength
          if (copied > source.size) {
            throw new BackupError('backupIncomplete')
          }
          controller.enqueue(next.value)
          onProgress(copied)
        } catch (error) {
          const failure = sourceReadError(error)
          if (failure instanceof TypeError) {
            const unreadable = new BackupError('backupSourceUnavailable')
            unreadable.cause = failure
            controller.error(unreadable)
          } else {
            controller.error(failure)
          }
          release()
        }
      },
      async cancel(reason) {
        if (released) {
          return
        }
        try {
          await reader.cancel(reason)
        } finally {
          release()
        }
      },
    })
    let writable: FileSystemWritableFileStream
    try {
      writable = await handle.createWritable()
    } catch (error) {
      await stream.cancel(error)
      throw error
    }
    await stream.pipeTo(writable, { signal })
    signal.throwIfAborted()
    const file = await handle.getFile()
    if (file.size !== source.size) {
      throw new BackupError('backupIncomplete')
    }
    return { file, dispose }
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      // eslint-disable-next-line no-console
      console.error('导入文件副本清理失败', cleanupError)
    }
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      const failure = new BackupError('backupStorageFull')
      failure.cause = error
      throw failure
    }
    throw sourceReadError(error)
  }
}
