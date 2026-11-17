import { create } from 'zustand'
import { apiJson, setBackendUserId } from './backend.js'
import { setApiKey } from './settings.js'
import { resetChatState } from './chat/store.js'

export type AuthUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  hasCustomApiKey: boolean
}

export const useAuth = create<{
  user: AuthUser | null
  loading: boolean
  error: string | null
}>(() => ({ user: null, loading: true, error: null }))

let initializing: Promise<void> | undefined

const acceptUser = (user: AuthUser) => {
  if (useAuth.getState().user?.id !== user.id) {
    resetChatState()
  }
  setBackendUserId(user.id)
  setApiKey(user.hasCustomApiKey ? 'configured' : null)
  useAuth.setState({ user, loading: false, error: null })
}

export const initializeAuth = (): Promise<void> => {
  if (initializing) {
    return initializing
  }
  initializing = apiJson<{ user: AuthUser }>('/api/auth/me')
    .then(({ user }) => acceptUser(user))
    .catch((error: unknown) => {
      const status = error instanceof Error && 'status' in error ? error.status : undefined
      useAuth.setState({
        user: null,
        loading: false,
        error: status === 401 ? null : error instanceof Error ? error.message : '无法加载登录状态',
      })
    })
    .finally(() => {
      initializing = undefined
    })
  return initializing
}

export const login = async (username: string, password: string): Promise<void> => {
  const { user } = await apiJson<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  acceptUser(user)
}

export const register = async (
  username: string,
  password: string,
  inviteCode: string
): Promise<void> => {
  const { user } = await apiJson<{ user: AuthUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, inviteCode }),
  })
  acceptUser(user)
}

export const adminLogin = async (): Promise<void> => {
  try {
    const { user } = await apiJson<{ user: AuthUser }>('/api/admin/login', { method: 'POST' })
    acceptUser(user)
  } finally {
    useAuth.setState({ loading: false })
  }
}

const clearIdentity = () => {
  setBackendUserId(null)
  resetChatState()
  setApiKey(null)
  useAuth.setState({ user: null, loading: false, error: null })
}

export const logout = async (): Promise<void> => {
  await apiJson('/api/auth/logout', { method: 'POST' })
  clearIdentity()
  // Clear all rendered account-specific component state as well as pending network work.
  window.location.replace('/')
}

window.addEventListener('auth:expired', () => {
  if (useAuth.getState().user) {
    clearIdentity()
    window.location.replace('/')
  }
})
