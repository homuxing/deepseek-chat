import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { adminLogin, initializeAuth, login, register, useAuth } from '../../services/auth.js'
import { Button } from '../base/Button.js'
import styles from './AuthGate.module.css'

export { AccountControls } from './AccountControls.js'

type AuthMode = 'login' | 'register'
type EntryMode = 'regular' | 'adminCallback' | 'adminRedirect'

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() ? error.message : '暂时无法完成请求，请稍后重试。'

const getEntryMode = (): EntryMode => {
  const { pathname } = window.location
  if (pathname === '/admin') {
    return 'adminRedirect'
  }
  if (pathname === '/api/admin/access/callback') {
    return 'adminCallback'
  }
  return 'regular'
}

const isAdminCallback = () => window.location.pathname === '/api/admin/access/callback'
const usernamePattern = /^[a-zA-Z0-9_-]{3,32}$/
const hasValidUsername = (value: string) => usernamePattern.test(value)
const hasValidPassword = (value: string) => value.length >= 10 && value.length <= 128

export const AuthGate = ({ children }: { children: ReactNode }) => {
  const { user, loading, error } = useAuth()
  const [mode, setMode] = useState<AuthMode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [initializationError, setInitializationError] = useState<string | null>(null)
  const [initializationAttempt, setInitializationAttempt] = useState(0)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const usernameId = useId()
  const passwordId = useId()
  const inviteId = useId()
  const usernameHintId = useId()
  const passwordHintId = useId()
  const [entryMode] = useState(getEntryMode)
  const adminEntry = entryMode === 'adminCallback'

  useEffect(() => {
    let active = true
    setInitializing(true)
    setInitializationError(null)

    const initialize = async () => {
      if (entryMode === 'adminRedirect') {
        window.location.replace('/api/admin/access')
        return
      }
      try {
        if (entryMode === 'adminCallback') {
          await adminLogin()
          if (active && isAdminCallback()) {
            window.history.replaceState(null, '', '/')
          }
        } else {
          await initializeAuth()
        }
      } catch (reason) {
        if (active) {
          setInitializationError(errorMessage(reason))
        }
      } finally {
        if (active) {
          setInitializing(false)
        }
      }
    }

    void initialize()
    return () => {
      active = false
    }
  }, [entryMode, initializationAttempt])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) {
      return
    }
    if (mode === 'register') {
      if (!hasValidUsername(username)) {
        setSubmitError('用户名需为 3 至 32 个字符，仅限字母、数字、下划线和短横线。')
        return
      }
      if (!hasValidPassword(password)) {
        setSubmitError('密码需为 10 至 128 个字符。')
        return
      }
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (mode === 'login') {
        await login(username, password)
      } else {
        await register(username, password, inviteCode)
      }
    } catch (reason) {
      setSubmitError(errorMessage(reason))
    } finally {
      setSubmitting(false)
    }
  }

  const visibleError = submitError ?? error ?? initializationError

  if (initializing || (loading && !visibleError)) {
    return (
      <main className={styles.screen}>
        <div className={styles.loading} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <span>{adminEntry ? '正在验证管理员身份…' : '正在验证账户…'}</span>
        </div>
      </main>
    )
  }

  if (user) {
    return <>{children}</>
  }

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-labelledby="auth-heading">
        <header className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            D
          </span>
          <span>Deepseek Chat</span>
        </header>

        <div className={styles.intro}>
          <h1 id="auth-heading" className={styles.title}>
            {adminEntry ? '管理员登录' : mode === 'login' ? '登录' : '注册'}
          </h1>
        </div>

        {!adminEntry ? (
          <div className={styles.modeTabs} role="tablist" aria-label="账户操作">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={styles.modeTab}
              onClick={() => {
                setMode('login')
                setSubmitError(null)
              }}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={styles.modeTab}
              onClick={() => {
                setMode('register')
                setSubmitError(null)
              }}
            >
              注册
            </button>
          </div>
        ) : null}

        {visibleError ? (
          <div className={styles.error} role="alert">
            <span>{visibleError}</span>
            {adminEntry && initializationError ? (
              <button
                type="button"
                className={styles.retry}
                onClick={() => setInitializationAttempt((attempt) => attempt + 1)}
              >
                重试
              </button>
            ) : null}
          </div>
        ) : null}

        {adminEntry ? (
          <div className={styles.adminActions}>
            <Button block onClick={() => setInitializationAttempt((attempt) => attempt + 1)}>
              重新验证管理员身份
            </Button>
            <a className={styles.accessLink} href="/api/admin/access">
              打开 Cloudflare Access
            </a>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            <label className={styles.field} htmlFor={usernameId}>
              <span>用户名</span>
              <input
                id={usernameId}
                name="username"
                type="text"
                value={username}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={mode === 'register' ? 3 : undefined}
                maxLength={mode === 'register' ? 32 : undefined}
                pattern={mode === 'register' ? '[a-zA-Z0-9_-]{3,32}' : undefined}
                aria-describedby={mode === 'register' ? usernameHintId : undefined}
                disabled={submitting}
                onChange={(event) => {
                  setUsername(event.target.value)
                  setSubmitError(null)
                }}
              />
              {mode === 'register' ? (
                <span id={usernameHintId} className={styles.fieldHint}>
                  3 至 32 个字符，仅限字母、数字、下划线和短横线
                </span>
              ) : null}
            </label>
            <label className={styles.field} htmlFor={passwordId}>
              <span>密码</span>
              <input
                id={passwordId}
                name="password"
                type="password"
                value={password}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={mode === 'register' ? 10 : undefined}
                maxLength={mode === 'register' ? 128 : undefined}
                aria-describedby={mode === 'register' ? passwordHintId : undefined}
                disabled={submitting}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setSubmitError(null)
                }}
              />
              {mode === 'register' ? (
                <span id={passwordHintId} className={styles.fieldHint}>
                  10 至 128 个字符
                </span>
              ) : null}
            </label>
            {mode === 'register' ? (
              <label className={styles.field} htmlFor={inviteId}>
                <span>邀请码</span>
                <input
                  id={inviteId}
                  name="inviteCode"
                  type="text"
                  value={inviteCode}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  disabled={submitting}
                  onChange={(event) => {
                    setInviteCode(event.target.value)
                    setSubmitError(null)
                  }}
                />
              </label>
            ) : null}
            <Button type="submit" block disabled={submitting}>
              {submitting
                ? mode === 'login'
                  ? '登录中…'
                  : '创建中…'
                : mode === 'login'
                  ? '登录'
                  : '创建账户'}
            </Button>
          </form>
        )}

        {!adminEntry ? (
          <footer className={styles.footer}>
            <a className={styles.accessLink} href="/api/admin/access">
              管理员登录
            </a>
          </footer>
        ) : null}
      </section>
    </main>
  )
}
