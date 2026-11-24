import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'
import {
  assertBackendIdentity,
  captureBackendIdentity,
  onBackendIdentityChange,
} from '../backend.js'
import { importArchiveUpload } from './importArchiveUpload.js'
import { resetHistoryImportProgress, setHistoryImportProgress } from './importProgress.js'

export { BackupError } from './history/errors.js'

// 导出与全部删除串行处理，避免读取归档时数据被清空或替换事务交错。
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
 * 确认覆盖后调用：前端解析与并发上传在替换事务内完成，期间禁止会话修改并等待旧保存结束。
 * 活跃状态与离开保护从调用瞬间开始，直到队列、替换事务和最终状态更新全部结束。
 */
export const importHistory = (file: File): Promise<number> => {
  if (importActive) {
    return Promise.reject(new Error('正在导入历史，请等待当前导入完成'))
  }
  importActive = true
  const identity = captureBackendIdentity()
  const controller = new AbortController()
  const preventLeave = (event: BeforeUnloadEvent) => {
    event.preventDefault()
    // 浏览器只展示原生确认文案；returnValue 兼容仍要求该属性的版本。
    event.returnValue = ' '
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', preventLeave)
  }
  const unsubscribeIdentity = onBackendIdentityChange(() => {
    try {
      assertBackendIdentity(identity)
    } catch {
      controller.abort()
    }
  })
  // 排队期间同样展示导入进度，防止提前关闭设置或再次点击导入。
  resetHistoryImportProgress()
  setHistoryImportProgress({ phase: 'checking', sessions: 0, files: 0 })
  const task = enqueueBackup(async () => {
    try {
      assertBackendIdentity(identity)
      await db.waitForStorageWrites()
      assertBackendIdentity(identity)
      const count = await replaceHistory(async () => {
        const result = await importArchiveUpload(file, identity, controller.signal)
        assertBackendIdentity(identity)
        if (result.sessions.length !== result.count) {
          throw new Error('导入结果中的会话数量不一致')
        }
        setHistoryImportProgress({
          phase: 'committing',
          sessions: result.count,
          files: result.files,
          totalSessions: result.totalSessions,
          totalFiles: result.totalFiles,
        })
        return result.sessions
      }, identity)
      assertBackendIdentity(identity)
      // 只更新最终阶段和会话数，保留处理阶段收到的真实附件计数。
      setHistoryImportProgress({ phase: 'done', sessions: count })
      return count
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted) {
        message = '登录账号已变更，导入已取消'
      }
      setHistoryImportProgress({ phase: 'error', error: message })
      throw error
    } finally {
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', preventLeave)
      }
      unsubscribeIdentity()
      importActive = false
    }
  })
  return task
}

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> => {
  const identity = captureBackendIdentity()
  return enqueueBackup(async () => {
    await replaceHistory(() => db.clearCloudHistory(identity), identity)
  })
}
