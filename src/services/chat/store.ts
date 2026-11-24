import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { ChatModel, CreateMessageRequest } from '../api/types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import { useSettings } from '../settings.js'
import { translate } from '../../i18n/index.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import { assertBackendIdentity, captureBackendIdentity, type BackendIdentity } from '../backend.js'
import {
  clearFileResources,
  releasePendingFileResources,
  retainPendingFileResources,
} from './fileResources.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  syncError: string | null
  syncErrorKind: 'read' | 'action' | null
  sessionConflictErrors: Record<string, boolean>
  /** 正在把冲突会话的本地内容另存为副本的会话 */
  resolvingConflictId: string | null
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  syncError: null,
  syncErrorKind: null,
  sessionConflictErrors: {},
  resolvingConflictId: null,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort(
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt
  )

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  a.pinned === b.pinned &&
  a.revision === b.revision &&
  a.generation === b.generation

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
const conflictedSessions = new Set<string>()
const saveSequences = new Map<string, number>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
/** 冲突副本已写入但最新原会话尚未载入时，重试沿用它，避免重复创建副本。 */
const conflictCopies = new Map<string, SessionSummary>()
const conflictResolutionTasks = new Map<string, Promise<boolean>>()
const renameTasks = new Map<string, Promise<void>>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
type SessionLoad = {
  promise: Promise<void>
  generation?: string
  revision: number
  /** 已因响应落后目录而重读一次，避免目录与服务持续不一致时无限请求。 */
  staleReload: boolean
}
const sessionLoads = new Map<string, SessionLoad>()

/** 云端目录为准；本设备尚未保存或处于冲突中的标题和时间继续保留。 */
const mergeCloudSummaries = (cloud: SessionSummary[], local: SessionSummary[]) => {
  const merged = new Map(cloud.map((summary) => [summary.id, summary]))
  for (const summary of local) {
    if (unsavedSessions.has(summary.id) || conflictedSessions.has(summary.id)) {
      merged.set(summary.id, summary)
    }
  }
  return sortSessions([...merged.values()])
}

/** Invalidate pending loads and saves before another identity can use this page. */
export const resetChatState = () => {
  historyEpoch++
  for (const controller of Object.values(get().streaming)) {
    controller.abort()
  }
  for (const controller of titleRequests) {
    controller.abort()
  }
  titleRequests.clear()
  clearAllDrafts()
  sessionAccess.clear()
  unsavedSessions.clear()
  conflictedSessions.clear()
  saveSequences.clear()
  pendingFiles.clear()
  clearFileResources()
  deletingSessions.clear()
  deletionTasks.clear()
  streamFlushes.clear()
  conflictCopies.clear()
  conflictResolutionTasks.clear()
  renameTasks.clear()
  sessionLoads.clear()
  initTask = undefined
  historySyncTask = undefined
  historySyncPending = false
  set({
    ready: false,
    initError: false,
    syncError: null,
    syncErrorKind: null,
    sessionConflictErrors: {},
    resolvingConflictId: null,
    importingHistory: false,
    sessions: [],
    sessionCache: {},
    sessionLoadErrors: {},
    sessionSaveErrors: {},
    activeId: null,
    streaming: {},
  })
}

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (
      get().importingHistory ||
      deletingSessions.has(sessionId) ||
      conflictedSessions.has(sessionId)
    ) {
      return
    }
    const epoch = historyEpoch
    const sequence = (saveSequences.get(sessionId) ?? 0) + 1
    saveSequences.set(sessionId, sequence)
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then((summary) => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
          if (files) {
            releasePendingFileResources(files)
          }
        }
        if (saveSequences.get(sessionId) === sequence) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
        updateSession(sessionId, (current) => ({
          ...current,
          revision: summary.revision,
          generation: summary.generation,
        }))
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          if (error instanceof Error && 'status' in error && error.status === 409) {
            conflictedSessions.add(sessionId)
            // 已确认冲突后停止本轮生成，保留当前本地内容等待用户另存副本。
            getStreamController(sessionId)?.abort()
            set((state) => ({
              sessionConflictErrors: { ...state.sessionConflictErrors, [sessionId]: true },
            }))
          }
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach((id) => {
      if (!conflictedSessions.has(id)) {
        persist(id)
      }
    })
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: MODEL,
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/**
 * 同一版本合并并发读取；目录版本变化时替换旧任务，旧响应不能写入缓存。
 * 读到的正文比目录旧时丢弃，并立即按当前目录再读一次。
 */
const ensureSessionLoaded = (id: string, staleReload = false): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const summary = get().sessions.find((session) => session.id === id)
  if (!summary) {
    return Promise.resolve()
  }
  const summaryRevision = summary.revision ?? 0
  const pending = sessionLoads.get(id)
  if (
    pending &&
    pending.generation === summary.generation &&
    pending.revision === summaryRevision
  ) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load: SessionLoad = {
    promise: Promise.resolve(),
    generation: summary.generation,
    revision: summaryRevision,
    staleReload,
  }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const current = get().sessions.find((session) => session.id === id)
      if (!current) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      // 其他设备可能仍在生成，读取不会把远端进行中的回复改写为已停止。
      const normalized = normalizeSession(stored)
      const loadedRevision = normalized.revision ?? 0
      const currentRevision = current.revision ?? 0
      const sameGeneration = normalized.generation === current.generation
      const directoryChanged =
        load.generation !== current.generation || load.revision !== currentRevision
      const responseStale = !sameGeneration || loadedRevision < currentRevision
      if (directoryChanged || responseStale) {
        sessionLoads.delete(id)
        if (!load.staleReload) {
          await ensureSessionLoaded(id, true)
        } else {
          set((state) => ({
            sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true },
          }))
          db.reportStorageError('read current session version')(
            new Error('会话正文版本仍落后于当前目录')
          )
        }
        return
      }
      const session = normalized
      // 正文查询与目录来自同一 D1 版本；正文 revision 更高时以正文为准修正目录。
      if (loadedRevision > currentRevision) {
        set((state) => ({
          sessions: sortSessions(
            state.sessions.map((item) =>
              item.id === id ? toSessionSummary(normalized) : item
            )
          ),
        }))
      }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (
  write: () => Promise<SessionSummary[]>,
  identity: BackendIdentity = captureBackendIdentity()
): Promise<number> => {
  assertBackendIdentity(identity)
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  if (
    conflictedSessions.size > 0 ||
    conflictResolutionTasks.size > 0 ||
    get().resolvingConflictId !== null
  ) {
    throw new Error('请先处理所有会话冲突，再替换历史')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.allSettled(deletionTasks)
    // 目录重命名在替换前完成；之后新请求会因 importingHistory 被拒绝。
    await Promise.allSettled(renameTasks.values())
    await waitForIdle()
    // 在版本仍有效时等旧保存结束，期间出现的 409 要保留为冲突而不是被替换清掉。
    await db.waitForStorageWrites()
    assertBackendIdentity(identity)
    if (conflictedSessions.size > 0 || get().resolvingConflictId !== null) {
      throw new Error('保存期间出现会话冲突，历史未被替换')
    }
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    assertBackendIdentity(identity)
    const epoch = historyEpoch
    let summaries: SessionSummary[]
    try {
      summaries = await write()
      assertBackendIdentity(identity)
      if (epoch !== historyEpoch) {
        throw new Error('历史操作已取消')
      }
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    conflictedSessions.clear()
    conflictCopies.clear()
    conflictResolutionTasks.clear()
    renameTasks.clear()
    saveSequences.clear()
    pendingFiles.clear()
    clearFileResources()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      syncError: null,
      syncErrorKind: null,
      sessionConflictErrors: {},
      resolvingConflictId: null,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    assertBackendIdentity(identity)
    set({ importingHistory: false })
    retrySaveSessions()
    if (historySyncPending) {
      historySyncPending = false
      void synchronizeHistory()
    }
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

let historySyncTask: Promise<void> | undefined
let historySyncPending = false
/** 推送只使干净缓存失效；未保存或生成中的内容保留，版本校验防止覆盖其他设备。 */
export const synchronizeHistory = (): Promise<void> => {
  if (get().importingHistory) {
    historySyncPending = true
    return Promise.resolve()
  }
  if (historySyncTask) {
    historySyncPending = true
    return historySyncTask
  }
  const identity = captureBackendIdentity()
  const epoch = historyEpoch
  const task = (async () => {
    try {
      const snapshot = await db.loadHistorySnapshot(identity)
      assertBackendIdentity(identity)
      if (epoch !== historyEpoch || get().importingHistory) {
        return
      }
      const state = get()
      const cloud = new Map(snapshot.sessions.map((summary) => [summary.id, summary]))
      const cache: Record<string, Session> = {}
      for (const [id, session] of Object.entries(state.sessionCache)) {
        const summary = cloud.get(id)
        if (unsavedSessions.has(id) || Object.hasOwn(state.streaming, id)) {
          cache[id] = session
        } else if (
          summary &&
          session.revision === summary.revision &&
          session.generation === summary.generation
        ) {
          cache[id] = session
        }
      }
      set({
        ready: true,
        initError: false,
        syncError: null,
        syncErrorKind: null,
        sessions: mergeCloudSummaries(snapshot.sessions, state.sessions),
        sessionCache: cache,
        activeId:
          state.activeId !== null && (cloud.has(state.activeId) || cache[state.activeId])
            ? state.activeId
            : null,
      })
      const activeId = get().activeId
      if (activeId !== null && !getSession(activeId)) {
        await ensureSessionLoaded(activeId)
      }
    } catch (error) {
      try {
        assertBackendIdentity(identity)
      } catch {
        return
      }
      db.reportStorageError('读取多设备更新')(error)
      set({
        syncError: error instanceof Error ? error.message : '无法读取云端更新',
        syncErrorKind: 'read',
      })
    }
  })()
  historySyncTask = task
  return task.finally(() => {
    if (historySyncTask === task) {
      historySyncTask = undefined
    }
    if (historySyncPending && !get().importingHistory) {
      historySyncPending = false
      void synchronizeHistory()
    }
  })
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const renameSession = (id: string, title: string): Promise<void> => {
  if (
    get().importingHistory ||
    deletingSessions.has(id) ||
    get().resolvingConflictId === id
  ) {
    return Promise.resolve()
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
    return Promise.resolve()
  }
  const previousTask = renameTasks.get(id) ?? Promise.resolve()
  const task = previousTask
    .catch(() => {})
    .then(() => renameUnloadedSession(id, title))
  renameTasks.set(id, task)
  void task.finally(() => {
    if (renameTasks.get(id) === task) {
      renameTasks.delete(id)
    }
  })
  return task
}

/**
 * 未加载详情时先以目录版本提交重命名，再读取最新目录绑定 revision。
 * 失败时目录保持原样并显式报错，避免界面先把标题改成未保存成功的值。
 */
const renameUnloadedSession = async (id: string, title: string): Promise<void> => {
  const identity = captureBackendIdentity()
  const epoch = historyEpoch
  const summary = get().sessions.find((session) => session.id === id)
  if (!summary) {
    return
  }
  try {
    await db.renameSession(id, title, summary)
    assertBackendIdentity(identity)
    const snapshot = await db.loadHistorySnapshot(identity)
    assertBackendIdentity(identity)
    if (epoch !== historyEpoch) {
      return
    }
    set((state) => ({
      sessions: mergeCloudSummaries(snapshot.sessions, state.sessions),
      syncError: null,
      syncErrorKind: null,
    }))
  } catch (error) {
    try {
      assertBackendIdentity(identity)
    } catch {
      return
    }
    if (epoch !== historyEpoch) {
      return
    }
    db.reportStorageError('rename session')(error)
    set({
      syncError: error instanceof Error ? error.message : '重命名失败',
      syncErrorKind: 'action',
    })
  }
}

const preferredConflictId = () => {
  const state = get()
  if (state.activeId !== null && state.sessionConflictErrors[state.activeId]) {
    return state.activeId
  }
  return Object.keys(state.sessionConflictErrors).find(
    (id) => state.sessionConflictErrors[id]
  ) ?? null
}

/**
 * 把冲突会话当前的完整本地快照保存成新云端会话，再载入原会话的云端最新版本。
 * 副本写入成功前不改动原会话；失败或账号切换时原内容和附件原件继续保留。
 */
export const resolveSessionConflict = (sessionId?: string): Promise<boolean> => {
  if (get().importingHistory) {
    return Promise.resolve(false)
  }
  const id = sessionId ?? preferredConflictId()
  if (id === null || !conflictedSessions.has(id)) {
    return Promise.resolve(false)
  }
  const existing = conflictResolutionTasks.get(id)
  if (existing) {
    return existing
  }
  const task = resolveSessionConflictData(id).finally(() => {
    if (conflictResolutionTasks.get(id) === task) {
      conflictResolutionTasks.delete(id)
    }
  })
  conflictResolutionTasks.set(id, task)
  return task
}

const resolveSessionConflictData = async (sessionId: string): Promise<boolean> => {
  const identity = captureBackendIdentity()
  const epoch = historyEpoch
  set({
    resolvingConflictId: sessionId,
    syncError: null,
    syncErrorKind: null,
  })
  try {
    getStreamController(sessionId)?.abort()
    await waitForIdle(sessionId)
    assertBackendIdentity(identity)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.waitForStorageWrites()
    assertBackendIdentity(identity)
    if (epoch !== historyEpoch || !conflictedSessions.has(sessionId)) {
      return false
    }
    const local = getSession(sessionId)
    if (!local) {
      throw new Error('冲突会话尚未加载，本地内容未保存')
    }

    let copySummary = conflictCopies.get(sessionId)
    if (!copySummary) {
      // 先读取账号当前 generation，新副本必须写入正在使用的云端历史。
      const snapshot = await db.loadHistorySnapshot(identity)
      assertBackendIdentity(identity)
      if (epoch !== historyEpoch || !conflictedSessions.has(sessionId)) {
        return false
      }
      const latestLocal = getSession(sessionId)
      if (!latestLocal) {
        throw new Error('冲突会话尚未加载，本地内容未保存')
      }
      const now = Date.now()
      const copySession: Session = {
        ...structuredClone(latestLocal),
        id: createId(),
        title: translate('conflictCopyTitle', {
          title: latestLocal.title || translate('untitledChat'),
        }),
        createdAt: now,
        updatedAt: now,
        revision: undefined,
        generation: snapshot.generation,
      }
      const files = pendingFiles.get(sessionId)
      const savedCopy = await db.saveSession(copySession, files ?? [])
      assertBackendIdentity(identity)
      if (epoch !== historyEpoch) {
        return false
      }
      copySummary = savedCopy
      copySession.revision = savedCopy.revision
      copySession.generation = savedCopy.generation
      conflictCopies.set(sessionId, savedCopy)
      touchSession(copySession.id)
      set((state) => ({
        sessions: sortSessions([
          savedCopy,
          ...state.sessions.filter((summary) => summary.id !== savedCopy.id),
        ]),
        sessionCache: { ...state.sessionCache, [copySession.id]: copySession },
      }))
      // 副本保存时已上传共享原件，此后由云端原件接管预览。
      if (pendingFiles.get(sessionId) === files) {
        pendingFiles.delete(sessionId)
        if (files) {
          releasePendingFileResources(files)
        }
      }
    }

    const loaded = await db.loadSession(sessionId)
    assertBackendIdentity(identity)
    if (epoch !== historyEpoch) {
      return false
    }
    const latest = loaded ? normalizeSession(structuredClone(loaded)) : undefined
    const copyId = copySummary.id
    conflictedSessions.delete(sessionId)
    unsavedSessions.delete(sessionId)
    saveSequences.delete(sessionId)
    conflictCopies.delete(sessionId)
    touchSession(sessionId)
    set((state) => {
      const sessions = new Map(state.sessions.map((summary) => [summary.id, summary]))
      const cache = latest
        ? { ...state.sessionCache }
        : Object.fromEntries(
            Object.entries(state.sessionCache).filter(([id]) => id !== sessionId)
          )
      if (latest) {
        sessions.set(sessionId, toSessionSummary(latest))
        cache[sessionId] = latest
      } else {
        sessions.delete(sessionId)
      }
      return {
        sessions: sortSessions([...sessions.values()]),
        sessionCache: cache,
        sessionConflictErrors: Object.fromEntries(
          Object.entries(state.sessionConflictErrors).filter(([id]) => id !== sessionId)
        ),
        sessionSaveErrors: Object.fromEntries(
          Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
        ),
        activeId:
          state.activeId === sessionId ? (latest ? sessionId : copyId) : state.activeId,
        syncError: null,
        syncErrorKind: null,
      }
    })
    trimSessionCache()
    return true
  } catch (error) {
    try {
      assertBackendIdentity(identity)
    } catch {
      return false
    }
    if (epoch !== historyEpoch) {
      return false
    }
    db.reportStorageError('处理会话冲突')(error)
    set({
      syncError: error instanceof Error ? error.message : '无法保留本地副本',
      syncErrorKind: 'action',
    })
    return false
  } finally {
    try {
      assertBackendIdentity(identity)
      if (epoch === historyEpoch) {
        set((state) => ({
          resolvingConflictId:
            state.resolvingConflictId === sessionId ? null : state.resolvingConflictId,
        }))
      }
    } catch {
      // 账号切换已由 resetChatState 清空操作状态。
    }
    retrySaveSessions()
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (
    get().importingHistory ||
    deletingSessions.has(id) ||
    get().resolvingConflictId === id
  ) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(
      id,
      get().sessions.find((session) => session.id === id)
    )
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    const files = pendingFiles.get(id)
    pendingFiles.delete(id)
    if (files) {
      releasePendingFileResources(files)
    }
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) ||
      conflictedSessions.has(sessionId) ||
      get().resolvingConflictId === sessionId ||
      getStreamController(sessionId) ||
      !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  // 消息进入界面前交接原件，防止保存尚未完成时读取到 404 并永久失去缩略图。
  if (files.length > 0) {
    const originals = files.map(({ id, blob }) => ({ id, blob }))
    retainPendingFileResources(originals)
    pendingFiles.set(sessionId, [...(pendingFiles.get(sessionId) ?? []), ...originals])
  }
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    conflictedSessions.has(sessionId) ||
    get().resolvingConflictId === sessionId
  ) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    conflictedSessions.has(sessionId) ||
    get().resolvingConflictId === sessionId
  ) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    get().resolvingConflictId === sessionId
  ) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    conflictedSessions.has(sessionId) ||
    get().resolvingConflictId === sessionId
  ) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? MODEL,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    conflictedSessions.has(sessionId) ||
    get().resolvingConflictId === sessionId
  ) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0 || get().resolvingConflictId === sessionId) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).toReversed()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  let lastCheckpoint = Date.now()
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const messages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder
        )
        const events = streamMessage(
          useSettings.getState().apiKey ?? '',
          {
            model: initial.model ?? MODEL,
            system: SYSTEM_PROMPT,
            messages,
            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
            safety_check: SAFETY_CHECK,
            tools: serverTools(initial.search ?? false),
            ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
          },
          controller.signal
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
          // Keep partial replies in D1 so abrupt tab closure does not lose the entire answer.
          if (Date.now() - lastCheckpoint >= 5000) {
            flush()
            persist(sessionId)
            lastCheckpoint = Date.now()
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
