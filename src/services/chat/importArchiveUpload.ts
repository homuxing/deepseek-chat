import { assertBackendIdentity, type BackendIdentity } from '../backend.js'
import { createCloudImport } from './db.js'
import { checkArchiveFormat, importArchive } from '../../../shared/history/importArchive.js'
import { setHistoryImportProgress, useHistoryImportProgress } from './importProgress.js'
import type { SessionSummary } from './types.js'

export type ArchiveImportResult = {
  sessions: SessionSummary[]
  count: number
  files: number
  totalSessions: number
  totalFiles: number
}

/** 浏览器按条目解析 ZIP，批量会话与附件上传共用四个任务额度，失败后等待在途写入结束。 */
export const importArchiveUpload = async (
  file: File,
  identity: BackendIdentity,
  signal: AbortSignal
): Promise<ArchiveImportResult> => {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  let cloud: Awaited<ReturnType<typeof createCloudImport>> | undefined
  try {
    assertBackendIdentity(identity)
    controller.signal.throwIfAborted()
    const totals = await checkArchiveFormat(file)
    assertBackendIdentity(identity)
    controller.signal.throwIfAborted()
    setHistoryImportProgress({ phase: 'processing', sessions: 0, files: 0, ...totals })
    cloud = await createCloudImport(identity, controller.signal)
    await importArchive(file, cloud.sink, {
      concurrency: 4,
      sessionBatchSize: 16,
      sessionBatchBytes: 240 * 1024,
      yieldToUI: true,
      signal: controller.signal,
      onError: (error) => controller.abort(error),
    })
    assertBackendIdentity(identity)
    controller.signal.throwIfAborted()
    const progress = useHistoryImportProgress.getState()
    if (progress.sessions !== totals.totalSessions || progress.files !== totals.totalFiles) {
      throw new Error('导入内容数量不完整')
    }
    const sessions = await cloud.commit()
    return { sessions, count: sessions.length, files: progress.files, ...totals }
  } catch (error) {
    controller.abort(error)
    if (cloud) {
      try {
        await cloud.cancel()
      } catch (cleanupError) {
        // 取消失败保留原始导入原因，服务端定期清理本次未提交内容。
        // eslint-disable-next-line no-console
        console.error('未提交导入清理失败', cleanupError)
      }
    }
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
