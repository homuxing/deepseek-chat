import { loadFile, type StoredFile } from './db.js'

export type FileResource =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'missing' }
  | { status: 'error'; error: unknown }

type Entry = {
  state: FileResource
  listeners: Set<() => void>
  pending: boolean
  controller?: AbortController
}

const LOADING: FileResource = { status: 'loading' }
const resources = new Map<string, Entry>()

const notify = (entry: Entry, state: FileResource) => {
  entry.state = state
  entry.listeners.forEach((listener) => listener())
}

const releaseUrl = (entry: Entry) => {
  if (entry.state.status === 'ready') {
    URL.revokeObjectURL(entry.state.url)
  }
}

const removeUnused = (id: string, entry: Entry) => {
  if (!entry.pending && entry.listeners.size === 0 && resources.get(id) === entry) {
    entry.controller?.abort()
    releaseUrl(entry)
    resources.delete(id)
  }
}

const createEntry = (): Entry => ({ state: LOADING, listeners: new Set(), pending: false })

/** 发送前登记原件，图片显示无需等待远端保存；失败时由待保存会话继续持有。 */
export const retainPendingFileResources = (files: StoredFile[]) => {
  for (const file of files) {
    let entry = resources.get(file.id)
    if (!entry) {
      entry = createEntry()
      resources.set(file.id, entry)
    }
    entry.pending = true
    // 原件接管尚未完成的远端读取，旧请求不得覆盖这份确定存在的数据。
    entry.controller?.abort()
    entry.controller = undefined
    releaseUrl(entry)
    notify(entry, { status: 'ready', url: URL.createObjectURL(file.blob) })
  }
}

/** 保存完成或会话删除后解除持有；仍在显示的缩略图和预览共用同一个地址。 */
export const releasePendingFileResources = (files: StoredFile[]) => {
  for (const file of files) {
    const entry = resources.get(file.id)
    if (entry) {
      entry.pending = false
      removeUnused(file.id, entry)
    }
  }
}

export const getFileResource = (id: string): FileResource => resources.get(id)?.state ?? LOADING

/** 每个附件只发起一次读取，缩略图与大图订阅同一资源，最后一个使用者离开后释放。 */
export const subscribeFileResource = (id: string, listener: () => void): (() => void) => {
  let entry = resources.get(id)
  if (!entry) {
    entry = createEntry()
    resources.set(id, entry)
  }
  entry.listeners.add(listener)
  if (entry.state.status === 'loading' && !entry.controller) {
    const current = entry
    const controller = new AbortController()
    current.controller = controller
    void loadFile(id, controller.signal).then(
      (blob) => {
        if (resources.get(id) === current && current.controller === controller) {
          current.controller = undefined
          notify(
            current,
            blob ? { status: 'ready', url: URL.createObjectURL(blob) } : { status: 'missing' }
          )
        }
      },
      (error: unknown) => {
        if (resources.get(id) === current && current.controller === controller) {
          current.controller = undefined
          notify(current, { status: 'error', error })
        }
      }
    )
  }
  const current = entry
  return () => {
    current.listeners.delete(listener)
    removeUnused(id, current)
  }
}

/** 账号或历史整体切换时使所有旧读取失效，原件与地址都不能跨越这次切换。 */
export const clearFileResources = () => {
  const entries = [...resources.values()]
  resources.clear()
  for (const entry of entries) {
    entry.controller?.abort()
    releaseUrl(entry)
    notify(entry, LOADING)
  }
}
