import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { adminLogin, initializeAuth, login, register, useAuth } from '../../services/auth.js'
import { Button } from '../base/Button.js'
import styles from './AuthGate.module.css'

export { AccountControls } from './AccountControls.js'

type AuthMode = 'login' | 'register' | 'admin'

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() ? error.message : '暂时无法完成请求，请稍后重试。'

export const AuthGate = ({ children }: { children: ReactNode }) => {
  const { user, loading, error } = useAuth()
  const [mode, setMode] = useState<AuthMode>(() =>
    window.location.pathname === '/admin' ? 'admin' : 'login'
  )
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const usernameId = useId()
  const passwordId = useId()
  const inviteId = useId()
  const usernameHintId = useId()
  const passwordHintId = useId()
  const adminEntry = mode === 'admin'

  useEffect(() => {
    let active = true
    void initializeAuth().finally(() => {
      if (active) {
        setInitializing(false)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) {
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    useAuth.setState({ error: null })
    try {
      if (mode === 'admin') {
        await adminLogin(username, password)
        window.history.replaceState(null, '', '/')
      } else if (mode === 'login') {
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

  const visibleError = submitError ?? error
  if (initializing || (loading && !visibleError)) {
    return (
      <main className={styles.screen}>
        <div className={styles.loading} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <span>正在验证账户…</span>
        </div>
      </main>
    )
  }

  if (user && (!adminEntry || user.role === 'admin')) {
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
            {(['login', 'register'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={mode === tab}
                className={styles.modeTab}
                onClick={() => {
                  setMode(tab)
                  setPassword('')
                  setSubmitError(null)
                  useAuth.setState({ error: null })
                }}
              >
                {tab === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>
        ) : null}
        {visibleError ? (
          <div className={styles.error} role="alert">
            {visibleError}
          </div>
        ) : null}
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
              minLength={3}
              maxLength={32}
              pattern="[a-zA-Z0-9_-]{3,32}"
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
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
              minLength={10}
              maxLength={128}
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
              ? mode === 'register'
                ? '创建中…'
                : '登录中…'
              : mode === 'register'
                ? '创建账户'
                : '登录'}
          </Button>
        </form>
        <footer className={styles.footer}>
          <a className={styles.entryLink} href={adminEntry ? '/' : '/admin'}>
            {adminEntry ? '返回用户登录' : '管理员登录'}
          </a>
        </footer>
      </section>
    </main>
  )
}
