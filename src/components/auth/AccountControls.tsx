import { useState } from 'react'
import { logout, useAuth } from '../../services/auth.js'
import { AdminPanel } from '../admin/AdminPanel.js'
import { Modal } from '../base/Modal.js'
import styles from './AccountControls.module.css'

export const AccountControls = () => {
  const { user } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  if (!user) {
    return null
  }

  const initial = Array.from(user.username.trim())[0]?.toLocaleUpperCase('zh-CN') ?? '用'

  return (
    <>
      <div className={styles.controls}>
        <div className={styles.root} aria-label="账户">
          <div className={styles.identity}>
            <span className={styles.avatar} aria-hidden="true">
              {initial}
            </span>
            <span className={styles.details}>
              <span className={styles.username} title={user.username}>
                {user.username}
              </span>
              <span className={styles.role}>{user.role === 'admin' ? '管理员' : '成员'}</span>
            </span>
          </div>
          <div className={styles.actions}>
            {user.role === 'admin' ? (
              <button type="button" className={styles.adminLink} onClick={() => setAdminOpen(true)}>
                管理
              </button>
            ) : (
              <a className={styles.adminLink} href="/api/admin/access">
                管理员登录
              </a>
            )}
            <button
              type="button"
              className={styles.logout}
              disabled={loggingOut}
              onClick={() => {
                if (loggingOut) {
                  return
                }
                setLoggingOut(true)
                setLogoutError(null)
                void logout()
                  .catch((error: unknown) => {
                    setLogoutError(
                      error instanceof Error && error.message.trim()
                        ? error.message
                        : '退出失败，请稍后重试。'
                    )
                  })
                  .finally(() => setLoggingOut(false))
              }}
            >
              {loggingOut ? '退出中…' : '退出'}
            </button>
          </div>
        </div>
        {logoutError ? (
          <div className={styles.error} role="alert">
            {logoutError}
          </div>
        ) : null}
      </div>
      {adminOpen && user.role === 'admin' ? (
        <Modal
          title="管理控制台"
          closable
          className={styles.adminModal}
          mainClassName={styles.adminModalMain}
          onClose={() => setAdminOpen(false)}
        >
          <AdminPanel variant="modal" />
        </Modal>
      ) : null}
    </>
  )
}
