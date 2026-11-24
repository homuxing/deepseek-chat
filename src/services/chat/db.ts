import {
  apiJson,
  BackendError,
  backendFetch,
  backendResponseError,
  captureBackendIdentity,
  assertBackendIdentity,
  onBackendIdentityChange,
  type BackendIdentity,
} from '../backend.js'
import { setHistoryImportProgress } from './importProgress.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'
import type { ArchiveImportSink } from './history/importArchive.js'

export type StoredFile = { id: string; blob: Blob }
export type HistorySnapshot = { sessions: SessionSummary[]; generation: string; revision: number }
type UploadResult = { summary?: SessionSummary; generation?: string; revision?: number }
const CHUNK_BYTES = 8 * 1024 * 1024
const jsonHeaders = { 'Content-Type': 'application/json' }
const sessionMutations = new Map<string, Promise<unknown>>()
const savedVersions = new Map<string, number>()
let currentGeneration: string | undefined
let currentRevision = 0
const stagingSessions = new Map<string, Session>()
const stagingFiles = new Map<string, StoredFile>()

onBackendIdentityChange(() => {
  savedVersions.clear()
  currentGeneration = undefined
  currentRevision = 0
  stagingSessions.clear()
  stagingFiles.clear()
})
export const getHistoryVersion = () => ({
  generation: currentGeneration,
  revision: currentRevision,
})
const rememberVersion = (result: { generation?: string; revision?: number }) => {
  if (result.generation !== undefined) {
    if (currentGeneration !== undefined && currentGeneration !== result.generation) {
      savedVersions.clear()
    }
    currentGeneration = result.generation
  }
  if (result.revision !== undefined) {
    currentRevision = Math.max(currentRevision, result.revision)
  }
}
const enqueueSessionMutation = <T>(
  id: string,
  run: (identity: BackendIdentity) => Promise<T>
): Promise<T> => {
  const identity = captureBackendIdentity()
  const previous = sessionMutations.get(id) ?? Promise.resolve()
  const current = previous
    .catch(() => {})
    .then(async () => {
      assertBackendIdentity(identity)
      return run(identity)
    })
  sessionMutations.set(id, current)
  const remove = () => {
    if (sessionMutations.get(id) === current) {
      sessionMutations.delete(id)
    }
  }
  current.then(remove, remove)
  return current
}
export const waitForStorageWrites = async (): Promise<void> => {
  await Promise.allSettled(sessionMutations.values())
}

/** 每个对象分块上传，不用单个请求承载全部归档或超大会话。 */
const uploadObject = async (
  blob: Blob,
  metadata: Record<string, unknown>,
  identity: BackendIdentity,
  signal?: AbortSignal
): Promise<UploadResult> => {
  assertBackendIdentity(identity)
  const started = await apiJson<{ id: string }>(
    '/api/storage/uploads',
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(metadata),
      signal,
    },
    identity
  )
  if (!started?.id) {
    throw new Error('无法确认上传任务已创建')
  }
  const path = '/api/storage/uploads/' + encodeURIComponent(started.id)
  let complete = false
  try {
    const parts = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES))
    for (let part = 1; part <= parts; part++) {
      assertBackendIdentity(identity)
      const response = await backendFetch(
        path + '/parts/' + part,
        {
          method: 'PUT',
          body: blob.slice((part - 1) * CHUNK_BYTES, part * CHUNK_BYTES),
          signal,
        },
        identity
      )
      if (!response.ok) {
        throw await backendResponseError(response)
      }
    }
    let result: UploadResult
    try {
      result = await apiJson<UploadResult>(
        path + '/complete',
        {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ parts }),
          signal,
        },
        identity
      )
    } catch (error) {
      assertBackendIdentity(identity)
      if (signal?.aborted) {
        throw error
      }
      const status = await apiJson<UploadResult & { status?: string }>(path, {}, identity)
      if (status.status !== 'completed') {
        throw error
      }
      result = status
    }
    if (!result || typeof result !== 'object') {
      throw new Error('无法确认上传内容已保存')
    }
    complete = true
    return result
  } finally {
    if (!complete) {
      // 取消只处理本次上传；原有会话和其他设备的数据不受影响。
      try {
        assertBackendIdentity(identity)
        await apiJson(path, { method: 'DELETE' }, identity)
      } catch (error) {
        reportStorageError('取消未完成上传')(error)
      }
    }
  }
}
const uploadOriginal = async (
  file: StoredFile,
  identity: BackendIdentity,
  importId?: string,
  signal?: AbortSignal
) => {
  await uploadObject(
    file.blob,
    {
      kind: 'file',
      id: file.id,
      mimeType: file.blob.type || 'application/octet-stream',
      ...(importId ? { importId } : {}),
    },
    identity,
    signal
  )
}
export const loadHistorySnapshot = async (
  identity = captureBackendIdentity()
): Promise<HistorySnapshot> => {
  const result = await apiJson<HistorySnapshot>('/api/chats', {}, identity)
  if (!result || !Array.isArray(result.sessions)) {
    throw new Error('云端会话列表无效')
  }
  rememberVersion(result)
  return { ...result, sessions: result.sessions.map(toSessionSummary) }
}
export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await loadHistorySnapshot()).sessions
export const loadSession = async (id: string): Promise<Session | undefined> => {
  const identity = captureBackendIdentity()
  const response = await backendFetch('/api/chats/' + encodeURIComponent(id), {}, identity)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw await backendResponseError(response)
  }
  const body = (await response.json()) as { session: Session; summary?: SessionSummary }
  assertBackendIdentity(identity)
  if (!body?.session || body.session.id !== id) {
    throw new Error('云端会话内容无效')
  }
  return { ...body.session, ...body.summary }
}

/** 队列保留正文快照，成功写入的版本只供同一设备后续排队写入使用。 */
export const saveSession = (
  session: Session,
  files: StoredFile[] = []
): Promise<SessionSummary> => {
  const snapshot = structuredClone(session)
  const originals = [...files]
  const generation = session.generation ?? currentGeneration ?? 'legacy'
  const expectedRevision = session.revision ?? savedVersions.get(session.id) ?? 0
  const savedBeforeQueue = savedVersions.get(session.id) ?? 0
  return enqueueSessionMutation(session.id, async (identity) => {
    if (session.revision !== undefined && session.revision < savedBeforeQueue) {
      throw new BackendError('会话版本已变化，旧内容未覆盖云端数据', 409)
    }
    for (const file of originals) {
      await uploadOriginal(file, identity)
    }
    assertBackendIdentity(identity)
    const result = await uploadObject(
      new Blob([JSON.stringify({ ...snapshot, revision: undefined, generation: undefined })], {
        type: 'application/json',
      }),
      {
        kind: 'chat',
        id: snapshot.id,
        generation,
        expectedRevision: Math.max(expectedRevision, savedVersions.get(snapshot.id) ?? 0),
      },
      identity
    )
    if (!result.summary || result.summary.id !== snapshot.id) {
      throw new Error('无法确认会话已保存')
    }
    savedVersions.set(snapshot.id, result.summary.revision ?? expectedRevision + 1)
    rememberVersion(result)
    return result.summary
  })
}
const mutationHeaders = (id: string, summary?: SessionSummary) => {
  const revision = Math.max(summary?.revision ?? 0, savedVersions.get(id) ?? 0)
  return {
    ...jsonHeaders,
    ...(revision > 0
      ? {
          'X-Chat-Generation': summary?.generation ?? currentGeneration ?? 'legacy',
          'X-Chat-Revision': String(revision),
        }
      : {}),
  }
}
export const renameSession = (id: string, title: string, summary?: SessionSummary): Promise<void> =>
  enqueueSessionMutation(id, async (identity) => {
    const result = await apiJson<UploadResult>(
      '/api/chats/' + encodeURIComponent(id),
      {
        method: 'PATCH',
        headers: mutationHeaders(id, summary),
        body: JSON.stringify({ title }),
      },
      identity
    )
    if (result?.summary) {
      savedVersions.set(id, result.summary.revision ?? 0)
    }
    if (result) {
      rememberVersion(result)
    }
  })
export const deleteSession = (id: string, summary?: SessionSummary): Promise<void> =>
  enqueueSessionMutation(id, async (identity) => {
    const result = await apiJson<UploadResult>(
      '/api/chats/' + encodeURIComponent(id),
      {
        method: 'DELETE',
        headers: mutationHeaders(id, summary),
      },
      identity
    )
    savedVersions.delete(id)
    if (result) {
      rememberVersion(result)
    }
  })
export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  const identity = captureBackendIdentity()
  for (const file of files) {
    await uploadOriginal(file, identity)
  }
}
export const loadFile = async (id: string, signal?: AbortSignal): Promise<Blob | undefined> => {
  const identity = captureBackendIdentity()
  const response = await backendFetch('/api/files/' + encodeURIComponent(id), { signal }, identity)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw await backendResponseError(response)
  }
  const blob = await response.blob()
  assertBackendIdentity(identity)
  return blob
}
export const deleteFile = async (id: string): Promise<void> => {
  await apiJson(
    '/api/files/' + encodeURIComponent(id),
    { method: 'DELETE' },
    captureBackendIdentity()
  )
}
export const deleteStoredFile = deleteFile

/** 导入绑定发起账号、取消信号和云端起始版本，暂存内容对其他设备不可见。 */
export const createCloudImport = async (identity: BackendIdentity, signal: AbortSignal) => {
  await waitForStorageWrites()
  assertBackendIdentity(identity)
  const started = await apiJson<{ id: string; generation: string; revision: number }>(
    '/api/chats/imports',
    {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
      signal,
    },
    identity
  )
  if (!started?.id) {
    throw new Error('无法确认导入任务已创建')
  }
  const importId = started.id
  const fileIds = new Map<string, string>()
  let sessions = 0
  let files = 0
  const sink: ArchiveImportSink = {
    async addSession(source) {
      assertBackendIdentity(identity)
      const session = structuredClone(source)
      for (const message of session.messages) {
        if (message.role === 'user') {
          message.files = message.files.map((file) => {
            let remapped = fileIds.get(file.id)
            if (!remapped) {
              remapped = crypto.randomUUID()
              fileIds.set(file.id, remapped)
            }
            // 每处引用创建独立对象，共享附件始终按原始 ID 映射。
            return { ...file, id: remapped, serverId: null }
          })
        }
      }
      await uploadObject(
        new Blob([JSON.stringify(session)], { type: 'application/json' }),
        {
          kind: 'chat',
          id: session.id,
          importId,
        },
        identity,
        signal
      )
      setHistoryImportProgress({ phase: 'uploading', sessions: ++sessions, files })
    },
    async saveFiles(originals) {
      for (const file of originals) {
        let id = fileIds.get(file.id)
        if (!id) {
          id = crypto.randomUUID()
          fileIds.set(file.id, id)
        }
        await uploadOriginal({ ...file, id }, identity, importId, signal)
        setHistoryImportProgress({ phase: 'uploading', sessions, files: ++files })
      }
    },
    async updateFileTypes() {
      assertBackendIdentity(identity)
    },
  }
  const path = '/api/chats/imports/' + encodeURIComponent(importId)
  return {
    sink,
    async commit(): Promise<SessionSummary[]> {
      assertBackendIdentity(identity)
      setHistoryImportProgress({ phase: 'committing', sessions, files })
      let result: { generation: string; revision: number; count: number }
      try {
        result = await apiJson(
          path + '/commit',
          {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ count: sessions }),
            signal,
          },
          identity
        )
      } catch (error) {
        // 响应丢失后只查询任务结果，不重复提交覆盖操作。
        assertBackendIdentity(identity)
        if (signal.aborted) {
          throw error
        }
        const status = await apiJson<{
          status: string
          generation: string
          revision: number
          count: number
        }>(path, {}, identity)
        if (status.status !== 'committed') {
          throw error
        }
        result = status
      }
      if (!result || result.count !== sessions) {
        throw new Error('无法确认完整历史已保存')
      }
      rememberVersion(result)
      savedVersions.clear()
      try {
        return (await loadHistorySnapshot(identity)).sessions
      } catch (error) {
        throw new Error(
          '历史已保存至云端，但读取更新失败：' +
            (error instanceof Error ? error.message : String(error))
        )
      }
    },
    async cancel(): Promise<void> {
      assertBackendIdentity(identity)
      await apiJson(path, { method: 'DELETE' }, identity)
    },
  }
}
export const clearCloudHistory = async (
  identity = captureBackendIdentity()
): Promise<SessionSummary[]> => {
  await waitForStorageWrites()
  await apiJson('/api/chats', { method: 'DELETE' }, identity)
  savedVersions.clear()
  return (await loadHistorySnapshot(identity)).sessions
}
// 归档单元测试和调用方可使用内存暂存；生产导入使用逐条云端 sink。
export const clearStaging = async (): Promise<void> => {
  stagingSessions.clear()
  stagingFiles.clear()
}
export const addStagingSession = async (session: Session): Promise<void> => {
  if (stagingSessions.has(session.id)) {
    throw new Error('归档中存在重复会话')
  }
  stagingSessions.set(session.id, session)
}
export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    stagingFiles.set(file.id, file)
  }
}
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  for (const session of stagingSessions.values()) {
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          file.mimeType = types.get(file.id) ?? ''
        }
      }
    }
  }
}
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const identity = captureBackendIdentity()
  if (stagingSessions.size === 0 && stagingFiles.size === 0) {
    return clearCloudHistory(identity)
  }
  const cloud = await createCloudImport(identity, new AbortController().signal)
  try {
    for (const session of stagingSessions.values()) {
      await cloud.sink.addSession(session)
    }
    await cloud.sink.saveFiles([...stagingFiles.values()])
    const summaries = await cloud.commit()
    await clearStaging()
    return summaries
  } catch (error) {
    await cloud.cancel().catch(reportStorageError('取消导入'))
    throw error
  }
}
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[storage] ' + action, error)
}
