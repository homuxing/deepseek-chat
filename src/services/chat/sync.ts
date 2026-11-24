import {
  assertBackendIdentity,
  captureBackendIdentity,
  getBackendUserId,
  onBackendIdentityChange,
  type BackendIdentity,
} from '../backend.js'

const INITIAL_RETRY_DELAY = 1_000
const MAX_RETRY_DELAY = 30_000

const reportSyncError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

const isCurrentIdentity = (identity: BackendIdentity): boolean => {
  try {
    assertBackendIdentity(identity)
    return getBackendUserId() === identity.userId
  } catch {
    return false
  }
}

const isSameIdentity = (left: BackendIdentity, right: BackendIdentity) =>
  left.userId === right.userId && left.epoch === right.epoch

/**
 * 同一账号只保留一条推送连接；通知串行执行，执行期间的新通知合并为下一轮。
 */
export const bindHistorySync = (onChanged: () => Promise<void>): (() => void) => {
  const page = window
  const targetDocument = document
  let disposed = false
  let online = page.navigator?.onLine !== false
  let socket: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let connectionEpoch = 0
  let retryDelay = INITIAL_RETRY_DELAY
  let readyReceived = false
  let rejectedIdentity: BackendIdentity | undefined
  let notificationPending = false
  let notificationIdentity: BackendIdentity | undefined
  let notificationRunning = false

  const canConnect = () => {
    const identity = captureBackendIdentity()
    return (
      !disposed &&
      online &&
      targetDocument.visibilityState === 'visible' &&
      identity.userId !== null &&
      (!rejectedIdentity || !isSameIdentity(rejectedIdentity, identity))
    )
  }

  const clearReconnectTimer = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
  }

  const detachSocket = (closeSocket: boolean) => {
    connectionEpoch += 1
    clearReconnectTimer()
    readyReceived = false
    const current = socket
    socket = undefined
    current?.removeEventListener('open', handleOpen)
    current?.removeEventListener('message', handleMessage)
    current?.removeEventListener('close', handleClose)
    current?.removeEventListener('error', handleError)
    if (closeSocket && current && current.readyState < WebSocket.CLOSING) {
      current.close(1000, '多设备同步已停止')
    }
  }

  const clearNotifications = () => {
    notificationPending = false
    notificationIdentity = undefined
  }

  const runNotifications = async () => {
    if (notificationRunning) {
      return
    }
    notificationRunning = true
    try {
      while (notificationPending) {
        notificationPending = false
        const identity = notificationIdentity
        notificationIdentity = undefined
        if (!identity || disposed || !isCurrentIdentity(identity)) {
          continue
        }
        try {
          await onChanged()
        } catch (error) {
          reportSyncError('多设备同步回调执行失败', error)
        }
      }
    } finally {
      notificationRunning = false
      if (notificationPending) {
        void runNotifications()
      }
    }
  }

  const requestNotification = (identity: BackendIdentity) => {
    if (disposed || !isCurrentIdentity(identity)) {
      return
    }
    notificationIdentity = identity
    notificationPending = true
    void runNotifications()
  }

  const scheduleReconnect = () => {
    if (!canConnect() || reconnectTimer !== undefined) {
      return
    }
    const delay = Math.min(retryDelay, MAX_RETRY_DELAY)
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  const isCurrentSocketEvent = (event: Event) =>
    !disposed && socket !== undefined && event.currentTarget === socket

  const handleOpen = (event: Event) => {
    if (!isCurrentSocketEvent(event)) {
      return
    }
  }

  const handleMessage = (event: MessageEvent) => {
    if (!isCurrentSocketEvent(event) || !isCurrentIdentity(captureBackendIdentity())) {
      return
    }
    let message: unknown
    try {
      message = JSON.parse(String(event.data))
    } catch (error) {
      reportSyncError('多设备同步消息解析失败', error)
      return
    }
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      reportSyncError('多设备同步消息格式无效', message)
      return
    }
    const type = (message as { type?: unknown }).type
    if (type === 'ready') {
      if (readyReceived) {
        return
      }
      readyReceived = true
      retryDelay = INITIAL_RETRY_DELAY
      requestNotification(captureBackendIdentity())
    } else if (type === 'changed') {
      requestNotification(captureBackendIdentity())
    }
  }

  const handleError = (event: Event) => {
    if (isCurrentSocketEvent(event)) {
      reportSyncError('多设备同步连接发生错误', event)
    }
  }

  const handleClose = (event: CloseEvent) => {
    if (!isCurrentSocketEvent(event) || !socket) {
      return
    }
    const current = socket
    socket = undefined
    connectionEpoch += 1
    clearReconnectTimer()
    readyReceived = false
    current.removeEventListener('open', handleOpen)
    current.removeEventListener('message', handleMessage)
    current.removeEventListener('close', handleClose)
    current.removeEventListener('error', handleError)
    if (event.code === 1008) {
      rejectedIdentity = captureBackendIdentity()
      reportSyncError('多设备同步认证已失效', event.reason)
      // 通过当前账号的目录读取确认认证失效；执行中的读取结束后补一次通知。
      requestNotification(rejectedIdentity)
      return
    }
    reportSyncError(`多设备同步连接已关闭（${event.code || 'unknown'}）`, event.reason)
    scheduleReconnect()
  }

  const connect = () => {
    if (!canConnect() || socket) {
      return
    }
    clearReconnectTimer()
    const identity = captureBackendIdentity()
    const userId = identity.userId
    if (userId === null || !isCurrentIdentity(identity)) {
      return
    }
    const epoch = connectionEpoch
    const url = new URL('/api/sync', page.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('user', userId)
    let nextSocket: WebSocket
    try {
      nextSocket = new WebSocket(url)
    } catch (error) {
      reportSyncError('无法建立多设备同步连接', error)
      scheduleReconnect()
      return
    }
    socket = nextSocket
    readyReceived = false
    nextSocket.addEventListener('open', handleOpen)
    nextSocket.addEventListener('message', handleMessage)
    nextSocket.addEventListener('close', handleClose)
    nextSocket.addEventListener('error', handleError)
    if (
      disposed ||
      epoch !== connectionEpoch ||
      socket !== nextSocket ||
      !isCurrentIdentity(identity) ||
      !canConnect()
    ) {
      detachSocket(true)
    }
  }

  const readOrConnect = () => {
    if (!canConnect()) {
      return
    }
    const identity = captureBackendIdentity()
    if (socket?.readyState === WebSocket.OPEN) {
      requestNotification(identity)
    } else if (!socket) {
      connect()
    }
  }

  const restartForIdentity = () => {
    detachSocket(true)
    clearNotifications()
    rejectedIdentity = undefined
    retryDelay = INITIAL_RETRY_DELAY
    connect()
  }

  const handleVisibilityChange = () => {
    if (targetDocument.visibilityState === 'hidden') {
      detachSocket(true)
      clearNotifications()
      retryDelay = INITIAL_RETRY_DELAY
    } else {
      readOrConnect()
    }
  }

  const handleFocus = () => {
    readOrConnect()
  }

  const handleOnline = () => {
    online = true
    readOrConnect()
  }

  const handleOffline = () => {
    online = false
    detachSocket(true)
    clearNotifications()
    retryDelay = INITIAL_RETRY_DELAY
  }

  targetDocument.addEventListener('visibilitychange', handleVisibilityChange)
  page.addEventListener('focus', handleFocus)
  page.addEventListener('online', handleOnline)
  page.addEventListener('offline', handleOffline)
  const unsubscribeIdentity = onBackendIdentityChange(restartForIdentity)
  connect()

  return () => {
    disposed = true
    targetDocument.removeEventListener('visibilitychange', handleVisibilityChange)
    page.removeEventListener('focus', handleFocus)
    page.removeEventListener('online', handleOnline)
    page.removeEventListener('offline', handleOffline)
    unsubscribeIdentity()
    detachSocket(true)
    clearNotifications()
  }
}
