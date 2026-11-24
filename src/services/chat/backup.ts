import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'
import {
  assertBackendIdentity,
  captureBackendIdentity,
  onBackendIdentityChange,
} from '../backend.js'
import { setHistoryImportProgress } from './importProgress.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()
let importActive = false

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> => {
  const identity = captureBackendIdentity()
  return enqueueBackup(async () => {
    assertBackendIdentity(identity)
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        assertBackendIdentity(identity)
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        assertBackendIdentity(identity)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        if (session.generation !== summary.generation || session.revision !== summary.revision) {
          throw new Error('导出期间会话已更新，请重新导出')
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions(), async (id) => {
      assertBackendIdentity(identity)
      const original = await db.loadFile(id)
      assertBackendIdentity(identity)
      return original
    })
    assertBackendIdentity(identity)
    return { name: backupFileName(now), blob }
  })
}

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File): Promise<number> => {
  if (importActive) {
    return Promise.reject(new Error('正在导入历史，请等待当前导入完成'))
  }
  importActive = true
  const identity = captureBackendIdentity()
  const controller = new AbortController()
  const unsubscribe = onBackendIdentityChange(() => {
    try {
      assertBackendIdentity(identity)
    } catch {
      controller.abort()
    }
  })
  setHistoryImportProgress({ phase: 'checking', sessions: 0, files: 0 })
  return enqueueBackup(async () => {
    assertBackendIdentity(identity)
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    const count = await replaceHistory(async () => {
      const cloud = await db.createCloudImport(identity, controller.signal)
      try {
        setHistoryImportProgress({ phase: 'uploading', sessions: 0, files: 0 })
        await importArchive(file, cloud.sink)
        return await cloud.commit()
      } catch (error) {
        await cloud.cancel().catch(db.reportStorageError('取消未完成导入'))
        throw error
      }
    }, identity)
    assertBackendIdentity(identity)
    setHistoryImportProgress({ phase: 'done', sessions: count })
    return count
  })
    .catch((error: unknown) => {
      setHistoryImportProgress({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    })
    .finally(() => {
      importActive = false
      unsubscribe()
    })
}

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> => {
  const identity = captureBackendIdentity()
  return enqueueBackup(async () => {
    await replaceHistory(() => db.clearCloudHistory(identity), identity)
  })
}
