import { apiJson, backendFetch, backendResponseError, getBackendUserId } from '../backend.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** Original attachment bytes are stored server-side and are scoped to the current user. */
export type StoredFile = {
  id: string
  blob: Blob
}

type SessionResponse = {
  session: Session
}

type SessionListResponse = {
  sessions: SessionSummary[]
}

const stagingSessions = new Map<string, Session>()
const stagingFiles = new Map<string, StoredFile>()
const MAX_IMPORT_BYTES = 1024 * 1024

/**
 * Serialize writes for each conversation. A save may wait for original uploads before
 * updating D1, so later state from a previous save must not overwrite newer state.
 */
const sessionMutations = new Map<string, Promise<void>>()

const assertBackendUser = (expectedUserId: string | null) => {
  if (getBackendUserId() !== expectedUserId) {
    throw new Error('Backend user changed before storage mutation completed')
  }
}

const enqueueSessionMutation = (
  id: string,
  run: (expectedUserId: string | null) => Promise<void>
): Promise<void> => {
  // Capture before yielding to the queue; the closure must not bind to a newer tab's user.
  const expectedUserId = getBackendUserId()
  const previous = sessionMutations.get(id) ?? Promise.resolve()
  const current = previous
    .catch(() => {})
    .then(async () => {
      assertBackendUser(expectedUserId)
      await run(expectedUserId)
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

const waitForSessionMutations = async () => {
  await Promise.allSettled(sessionMutations.values())
}

const chatPath = (id: string) => `/api/chats/${encodeURIComponent(id)}`
const filePath = (id: string) => `/api/files/${encodeURIComponent(id)}`
const jsonHeaders = { 'Content-Type': 'application/json' }

const uploadOriginal = async (file: StoredFile): Promise<void> => {
  const response = await backendFetch(filePath(file.id), {
    method: 'POST',
    headers: file.blob.type ? { 'Content-Type': file.blob.type } : undefined,
    body: file.blob,
  })
  if (!response.ok) {
    throw await backendResponseError(response)
  }
}

const uploadOriginals = async (files: StoredFile[]): Promise<void> => {
  await Promise.all(files.map(uploadOriginal))
}

/**
 * Give staged originals fresh IDs for one import attempt. Sessions are cloned so the
 * remapped references cannot alter the staging snapshot needed for a later retry.
 */
const remapStagingForCommit = () => {
  const files: StoredFile[] = []
  const remappedIds = new Map<string, string>()
  for (const file of stagingFiles.values()) {
    const id = crypto.randomUUID()
    remappedIds.set(file.id, id)
    files.push({ id, blob: file.blob })
  }

  const sessions = structuredClone([...stagingSessions.values()])
  for (const session of sessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        const id = remappedIds.get(file.id)
        if (id) {
          file.id = id
          file.serverId = null
        }
      }
    }
  }
  return { files, sessions }
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const body = await apiJson<SessionListResponse>('/api/chats')
  return body.sessions.map(toSessionSummary)
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const response = await backendFetch(chatPath(id))
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw await backendResponseError(response)
  }
  const body = (await response.json()) as SessionResponse
  return body.session
}

/**
 * Save an immutable snapshot. Serialization happens before awaiting file uploads so
 * store state can continue changing while the request is in flight.
 */
export const saveSession = (session: Session, files: StoredFile[] = []): Promise<void> => {
  const id = session.id
  const body = JSON.stringify({ session })
  const originals = files.map((file) => ({ id: file.id, blob: file.blob }))
  return enqueueSessionMutation(id, async (expectedUserId) => {
    await uploadOriginals(originals)
    assertBackendUser(expectedUserId)
    await apiJson<unknown>(chatPath(id), {
      method: 'PUT',
      headers: jsonHeaders,
      body,
    })
  })
}

/** Rename without loading the conversation; the server updates its summary atomically. */
export const renameSession = (id: string, title: string): Promise<void> => {
  const body = JSON.stringify({ title })
  return enqueueSessionMutation(id, async () => {
    await apiJson<unknown>(chatPath(id), {
      method: 'PATCH',
      headers: jsonHeaders,
      body,
    })
  })
}

/** Delete a conversation. The server removes any originals no longer referenced by it. */
export const deleteSession = (sessionId: string): Promise<void> =>
  enqueueSessionMutation(sessionId, async () => {
    await apiJson<unknown>(chatPath(sessionId), { method: 'DELETE' })
  })

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  const expectedUserId = getBackendUserId()
  assertBackendUser(expectedUserId)
  await uploadOriginals(files)
}

export const loadFile = async (id: string, signal?: AbortSignal): Promise<Blob | undefined> => {
  const response = await backendFetch(filePath(id), { signal })
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw await backendResponseError(response)
  }
  return response.blob()
}

export const deleteFile = async (id: string): Promise<void> => {
  const expectedUserId = getBackendUserId()
  assertBackendUser(expectedUserId)
  await apiJson<unknown>(filePath(id), { method: 'DELETE' })
}

export const deleteStoredFile = deleteFile

/** Clear only the in-memory import staging; no remote data is touched. */
export const clearStaging = async (): Promise<void> => {
  stagingSessions.clear()
  stagingFiles.clear()
}

export const addStagingSession = async (session: Session): Promise<void> => {
  if (stagingSessions.has(session.id)) {
    throw new Error(`Duplicate staged session: ${session.id}`)
  }
  stagingSessions.set(session.id, session)
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    stagingFiles.set(file.id, file)
  }
}

/** Image bytes arrive after session JSON, so fill their MIME types before upload. */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  for (const session of stagingSessions.values()) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        file.mimeType = types.get(file.id) ?? ''
      }
    }
  }
}

/**
 * Each attempt uses fresh original IDs and checks the serialized request size before
 * uploading. A failed import cannot overwrite existing originals or mutate staging.
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const expectedUserId = getBackendUserId()
  if (stagingSessions.size > 200) {
    throw new Error('Chat history import supports at most 200 conversations')
  }

  if (stagingSessions.size === 0 && stagingFiles.size === 0) {
    await waitForSessionMutations()
    assertBackendUser(expectedUserId)
    await apiJson<unknown>('/api/chats', { method: 'DELETE' })
    await clearStaging()
    return []
  }

  const remapped = remapStagingForCommit()
  const body = JSON.stringify({ sessions: remapped.sessions })
  if (new TextEncoder().encode(body).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('Chat history import exceeds the 1 MiB request limit')
  }

  await waitForSessionMutations()
  assertBackendUser(expectedUserId)
  await uploadOriginals(remapped.files)
  assertBackendUser(expectedUserId)
  const result = await apiJson<SessionListResponse>('/api/chats/import', {
    method: 'POST',
    headers: jsonHeaders,
    body,
  })
  if (!Array.isArray(result.sessions)) {
    throw new Error('The server returned an invalid imported chat list')
  }
  await clearStaging()
  return result.sessions.map(toSessionSummary)
}

/** Server storage failures do not interrupt the conversation; keep the error in the console. */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
