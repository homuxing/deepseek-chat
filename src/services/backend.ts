/** All first-party requests go through the same-origin application proxy. */
export const API_ORIGIN = '/api'

let backendUserId: string | null = null
let backendIdentityEpoch = 0
const identityListeners = new Set<() => void>()

export type BackendIdentity = { userId: string | null; epoch: number }
export const captureBackendIdentity = (): BackendIdentity => ({
  userId: backendUserId,
  epoch: backendIdentityEpoch,
})
export const assertBackendIdentity = (identity: BackendIdentity): void => {
  if (identity.userId !== backendUserId || identity.epoch !== backendIdentityEpoch) {
    throw new BackendError('登录账号已变更，操作已取消', 409)
  }
}
export const onBackendIdentityChange = (listener: () => void): (() => void) => {
  identityListeners.add(listener)
  return () => identityListeners.delete(listener)
}

/** Keep requests pinned to the account shown by the current application state. */
export const setBackendUserId = (id: string | null): void => {
  if (backendUserId === id) {
    return
  }
  backendIdentityEpoch++
  backendUserId = id
  identityListeners.forEach((listener) => listener())
}

export const getBackendUserId = (): string | null => backendUserId

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const AUTH_RACE_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/me',
  '/api/admin/login',
  '/api/login',
  '/api/register',
  '/api/me',
])

const isErrorBody = (value: unknown): value is { error: { message: string } } =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as { error?: { message?: unknown } }).error?.message === 'string'

const errorMessage = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '')
  if (!text) {
    return response.statusText || `HTTP ${response.status}`
  }
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      return body.error.message
    }
  } catch {
    // Plain-text errors are shown as-is.
  }
  return text
}

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

/** 仅标记 fetch 与响应读取阶段的传输失败，避免把程序 TypeError 当成断网恢复。 */
export class BackendConnectionError extends TypeError {
  constructor(error: TypeError) {
    super(error.message, { cause: error })
    this.name = 'BackendConnectionError'
  }
}

export const backendResponseError = async (response: Response): Promise<BackendError> =>
  new BackendError(await errorMessage(response), response.status)

const eventPath = (path: string): string => {
  try {
    return new URL(path, 'http://localhost').pathname
  } catch {
    return path.split('?')[0] ?? path
  }
}

const notifyAuthExpired = (path: string) => {
  type EventTargetLike = {
    dispatchEvent?: (event: Event) => boolean
  }
  const root = globalThis as unknown as {
    dispatchEvent?: (event: Event) => boolean
    window?: EventTargetLike
  }
  const target = root.window?.dispatchEvent ? root.window : root
  if (typeof target.dispatchEvent !== 'function' || AUTH_RACE_PATHS.has(eventPath(path))) {
    return
  }
  target.dispatchEvent(new Event('auth:expired'))
}

/**
 * Fetch a first-party backend route with cookies and CSRF protection.
 * Non-2xx responses are returned so callers can handle expected 404s.
 */
export const backendFetch = async (
  path: string,
  init: RequestInit = {},
  identity?: BackendIdentity
): Promise<Response> => {
  if (identity) {
    assertBackendIdentity(identity)
  }
  if (!path.startsWith(`${API_ORIGIN}/`)) {
    throw new Error(`Backend paths must start with ${API_ORIGIN}/`)
  }
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (backendUserId !== null) {
    headers.set('X-Chat-User-ID', backendUserId)
  }
  if (MUTATION_METHODS.has(method)) {
    headers.set('X-Requested-With', 'XMLHttpRequest')
  }
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const requestInit = {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
  }
  let response: Response
  try {
    response = await fetch(path, requestInit as RequestInit)
  } catch (error) {
    throw error instanceof TypeError ? new BackendConnectionError(error) : error
  }
  if (identity) {
    assertBackendIdentity(identity)
  }
  if (response.headers.get('X-Auth-Expired') === '1') {
    notifyAuthExpired(path)
  }
  return response
}

/** Fetch and parse a JSON response, throwing the backend's nested error message. */
export const apiJson = async <T>(
  path: string,
  init: RequestInit = {},
  identity?: BackendIdentity
): Promise<T> => {
  const response = await backendFetch(path, init, identity)
  if (!response.ok) {
    throw await backendResponseError(response)
  }
  if (response.status === 204) {
    return undefined as T
  }
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw error instanceof TypeError ? new BackendConnectionError(error) : error
  }
  if (identity) {
    assertBackendIdentity(identity)
  }
  if (!text) {
    return undefined as T
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new BackendError('The server returned an invalid JSON response', response.status)
  }
}
