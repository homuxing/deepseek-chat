import {
  BackendError,
  BackendConnectionError,
  assertBackendIdentity,
  type BackendIdentity,
} from '../backend.js'
import { setHistoryImportProgress } from './importProgress.js'

/** 只恢复连接与暂时不可用的响应；文件、权限、版本和数据错误须原样报告。 */
export const isImportConnectionError = (error: unknown): boolean =>
  error instanceof BackendConnectionError ||
  (error instanceof BackendError && [408, 429, 502, 503, 504].includes(error.status))

export const waitForImportConnection = async (
  identity: BackendIdentity,
  signal: AbortSignal,
  attempt: number
): Promise<void> => {
  assertBackendIdentity(identity)
  signal.throwIfAborted()
  setHistoryImportProgress({ waiting: true })
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', finish)
      }
      resolve()
    }
    const abort = () => {
      reject(signal.reason)
      finish()
    }
    // 失败恢复采用退避，恢复联网事件会立即唤醒；正常导入没有状态轮询。
    const timer = setTimeout(finish, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)))
    signal.addEventListener('abort', abort, { once: true })
    if (typeof window !== 'undefined') {
      window.addEventListener('online', finish, { once: true })
    }
  })
  assertBackendIdentity(identity)
  signal.throwIfAborted()
}

/** 仅供可安全恢复的导入请求使用，调用方保证任务 ID 或分片序号固定。 */
export const recoverImportConnection = async <T>(
  run: () => Promise<T>,
  identity: BackendIdentity,
  signal: AbortSignal
): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    assertBackendIdentity(identity)
    signal.throwIfAborted()
    try {
      const result = await run()
      setHistoryImportProgress({ waiting: undefined })
      return result
    } catch (error) {
      assertBackendIdentity(identity)
      signal.throwIfAborted()
      if (!isImportConnectionError(error)) {
        throw error
      }
      await waitForImportConnection(identity, signal, attempt)
    }
  }
}
