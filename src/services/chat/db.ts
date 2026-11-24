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
import {
  isImportConnectionError,
  recoverImportConnection,
  waitForImportConnection,
} from './importTransport.js'
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
  const importing = typeof metadata.importId === 'string' && signal
  const connect = <T>(run: () => Promise<T>): Promise<T> =>
    importing ? recoverImportConnection(run, identity, signal) : run()
  const uploadId = importing ? crypto.randomUUID() : undefined
  const started = await connect(() =>
    apiJson<{ id: string }>(
      '/api/storage/uploads',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ ...metadata, ...(uploadId ? { uploadId } : {}) }),
        signal,
      },
      identity
    )
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
      const chunk = blob.slice((part - 1) * CHUNK_BYTES, part * CHUNK_BYTES)
      await connect(async () => {
        const response = await backendFetch(
          path + '/parts/' + part,
          {
            method: 'PUT',
            body: chunk,
            signal,
          },
          identity
        )
        if (!response.ok) {
          throw await backendResponseError(response)
        }
      })
    }
    let result: UploadResult
    for (let attempt = 0; ; attempt++) {
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
        break
      } catch (error) {
        assertBackendIdentity(identity)
        if (signal?.aborted) {
          throw error
        }
        let status = await connect(() =>
          apiJson<UploadResult & { status?: string }>(path, {}, identity)
        )
        // 完成响应不确定时读取既有任务，完成中的任务只等待其结果。
        while (importing && status.status === 'completing' && isImportConnectionError(error)) {
          await waitForImportConnection(identity, signal, attempt++)
          status = await connect(() =>
            apiJson<UploadResult & { status?: string }>(path, {}, identity)
          )
        }
        if (status.status === 'completed') {
          result = status
          break
        }
        if (!importing || status.status !== 'uploading' || !isImportConnectionError(error)) {
          throw error
        }
        await waitForImportConnection(identity, signal, attempt)
      }
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
/** 整包导入提交后直接使用返回的目录与版本，清除旧会话保存版本。 */
export const acceptImportedHistory = (result: HistorySnapshot): SessionSummary[] => {
  rememberVersion(result)
  savedVersions.clear()
  return result.sessions.map(toSessionSummary)
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
  const connect = <T>(run: () => Promise<T>) => recoverImportConnection(run, identity, signal)
  const requestedId = crypto.randomUUID()
  const started = await connect(() =>
    apiJson<{ id: string; generation: string; revision: number }>(
      '/api/chats/imports',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ id: requestedId }),
        signal,
      },
      identity
    )
  )
  if (!started?.id) {
    throw new Error('无法确认导入任务已创建')
  }
  const importId = started.id
  const fileIds = new Map<string, string>()
  const fileTypes = new Map<string, string>()
  const path = '/api/chats/imports/' + encodeURIComponent(importId)
  const remapFile = (id: string) => {
    let remapped = fileIds.get(id)
    if (!remapped) {
      remapped = crypto.randomUUID()
      fileIds.set(id, remapped)
    }
    return remapped
  }
  const prepareSession = (source: Session) => {
    const session = structuredClone(source)
    for (const message of session.messages) {
      if (message.role === 'user') {
        message.files = message.files.map((file) => ({
          ...file,
          id: remapFile(file.id),
          serverId: null,
          mimeType: fileTypes.get(file.id) ?? file.mimeType,
        }))
      }
    }
    return session
  }
  let sessions = 0
  let files = 0
  const progress = () => {
    assertBackendIdentity(identity)
    signal.throwIfAborted()
    setHistoryImportProgress({ phase: 'processing', sessions, files })
  }
  const saveBatch = async (sources: Session[]) => {
    assertBackendIdentity(identity)
    signal.throwIfAborted()
    const batch = sources.map(prepareSession)
    const body = JSON.stringify({ sessions: batch })
    // 附件 ID 映射可能扩大 JSON，发送前再次按实际字节复核请求边界。
    if (new Blob([body]).size > 256 * 1024 || batch.length > 16) {
      if (sources.length === 1) {
        const session = batch[0]
        await uploadObject(
          new Blob([JSON.stringify(session)], { type: 'application/json' }),
          { kind: 'chat', id: session.id, importId },
          identity,
          signal
        )
        sessions++
        progress()
      } else {
        const middle = Math.ceil(sources.length / 2)
        await saveBatch(sources.slice(0, middle))
        await saveBatch(sources.slice(middle))
      }
      return
    }
    const result = await connect(() =>
      apiJson<{ count: number; sessions: SessionSummary[] }>(
        path + '/chats',
        { method: 'POST', headers: jsonHeaders, body, signal },
        identity
      )
    )
    if (
      !result ||
      result.count !== batch.length ||
      !Array.isArray(result.sessions) ||
      result.sessions.length !== batch.length ||
      new Set(result.sessions.map((session) => session.id)).size !== batch.length ||
      batch.some((session) => !result.sessions.some((saved) => saved.id === session.id))
    ) {
      throw new Error('无法确认全部会话已保存')
    }
    sessions += batch.length
    progress()
  }
  const sink: ArchiveImportSink = {
    async addSession(source) {
      assertBackendIdentity(identity)
      const session = prepareSession(source)
      const body = new Blob([JSON.stringify(session)], { type: 'application/json' })
      if (body.size + 15 <= 256 * 1024) {
        await saveBatch([source])
        return
      }
      await uploadObject(
        body,
        {
          kind: 'chat',
          id: session.id,
          importId,
        },
        identity,
        signal
      )
      sessions++
      progress()
    },
    addSessions: saveBatch,
    async saveFiles(originals) {
      for (const file of originals) {
        assertBackendIdentity(identity)
        signal.throwIfAborted()
        const id = remapFile(file.id)
        const mimeType = file.blob.type || 'application/octet-stream'
        fileTypes.set(file.id, mimeType)
        if (file.blob.size <= CHUNK_BYTES) {
          const result = await connect(() =>
            apiJson<{ id: string }>(
              path + '/files/' + encodeURIComponent(id),
              { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file.blob, signal },
              identity
            )
          )
          if (!result || result.id !== id) {
            throw new Error('无法确认附件已保存')
          }
        } else {
          await uploadOriginal({ ...file, id }, identity, importId, signal)
        }
        files++
        progress()
      }
    },
    async updateFileTypes() {
      assertBackendIdentity(identity)
    },
  }
  let committed = false
  return {
    sink,
    async commit(): Promise<SessionSummary[]> {
      assertBackendIdentity(identity)
      setHistoryImportProgress({ phase: 'committing', sessions, files })
      let result: {
        generation: string
        revision: number
        count: number
        sessions?: SessionSummary[]
      }
      for (let attempt = 0; ; attempt++) {
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
          break
        } catch (error) {
          // 响应丢失后先确认任务；只在尚未提交时恢复同一幂等提交。
          assertBackendIdentity(identity)
          if (signal.aborted) {
            throw error
          }
          const status = await connect(() =>
            apiJson<{
              status: string
              generation: string
              revision: number
              count: number
            }>(path, {}, identity)
          )
          if (status.status === 'committed') {
            result = status
            break
          }
          if (status.status !== 'staging' || !isImportConnectionError(error)) {
            throw error
          }
          await waitForImportConnection(identity, signal, attempt)
        }
      }
      if (
        !result ||
        result.count !== sessions ||
        typeof result.generation !== 'string' ||
        result.generation.length === 0 ||
        !Number.isSafeInteger(result.revision) ||
        result.revision < 1
      ) {
        throw new Error('无法确认完整历史已保存')
      }
      committed = true
      rememberVersion(result)
      savedVersions.clear()
      try {
        const listed =
          result.sessions === undefined
            ? await connect(() => loadHistorySnapshot(identity))
            : {
                generation: result.generation,
                revision: result.revision,
                sessions: result.sessions,
              }
        if (
          listed.generation !== result.generation ||
          !Array.isArray(listed.sessions) ||
          listed.sessions.length !== sessions ||
          new Set(listed.sessions.map((summary) => summary.id)).size !== sessions ||
          listed.sessions.some(
            (summary) =>
              typeof summary.id !== 'string' ||
              typeof summary.title !== 'string' ||
              !Number.isSafeInteger(summary.createdAt) ||
              !Number.isSafeInteger(summary.updatedAt)
          )
        ) {
          throw new Error('导入后的历史目录已变化或不完整')
        }
        return acceptImportedHistory(listed)
      } catch (error) {
        throw new Error(
          '历史已保存至云端，但读取更新失败：' +
            (error instanceof Error ? error.message : String(error))
        )
      }
    },
    async cancel(): Promise<void> {
      assertBackendIdentity(identity)
      if (committed) {
        return
      }
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
// 归档单元测试使用内存暂存；用户导入按有界并发边解析边上传。
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
