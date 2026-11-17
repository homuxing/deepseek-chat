import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { useAuth } from '../../services/auth.js'
import { apiJson } from '../../services/backend.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import styles from './AdminPanel.module.css'

type AdminTab = 'invites' | 'users'
type UserStatus = 'active' | 'disabled'
type UserRole = 'user' | 'admin'

type Invite = {
  id: string
  code: string | null
  maxUses: number
  uses: number
  expiresAt: number | null
  createdAt: number
}

type AdminUser = {
  id: string
  username: string
  role: UserRole
  status: UserStatus
  createdAt: number
  hasCustomApiKey: boolean
  sessionCount: number
}

type Confirmation =
  | { kind: 'invite'; id: string }
  | { kind: 'user'; id: string }
  | { kind: 'chats'; id: string }

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const formatDateTime = (timestamp: number) => dateTime.format(new Date(timestamp))

const formatExpiry = (timestamp: number | null) =>
  timestamp === null ? '永久有效' : formatDateTime(timestamp)

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() ? error.message : '请求失败，请稍后重试。'

const mutate = <T,>(path: string, init: RequestInit): Promise<T> => {
  const headers = new Headers(init.headers)
  headers.set('X-Requested-With', 'XMLHttpRequest')
  return apiJson<T>(path, { ...init, headers })
}

const toLocalInputValue = (timestamp: number) => {
  const date = new Date(timestamp)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(timestamp - offset).toISOString().slice(0, 16)
}

/** 私人部署管理台：邀请码与用户生命周期管理。 */
export const AdminPanel = ({
  variant = 'page',
}: {
  variant?: 'page' | 'modal'
} = {}) => {
  const { user: currentUser } = useAuth()
  const [tab, setTab] = useState<AdminTab>('invites')
  const [invites, setInvites] = useState<Invite[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [invitesLoading, setInvitesLoading] = useState(true)
  const [usersLoading, setUsersLoading] = useState(true)
  const [invitesError, setInvitesError] = useState<string | null>(null)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [passwordUserId, setPasswordUserId] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [maxUses, setMaxUses] = useState('1')
  const [expiresAt, setExpiresAt] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdCode, setCreatedCode] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [createError, setCreateError] = useState<string | null>(null)
  const passwordInputId = useId()

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true)
    setInvitesError(null)
    try {
      const result = await apiJson<{ invites: Invite[] }>('/api/admin/invites')
      setInvites(result.invites)
    } catch (error) {
      setInvitesError(errorMessage(error))
    } finally {
      setInvitesLoading(false)
    }
  }, [])

  const loadUsers = useCallback(async () => {
    setUsersLoading(true)
    setUsersError(null)
    try {
      const result = await apiJson<{ users: AdminUser[] }>('/api/admin/users')
      setUsers(result.users)
    } catch (error) {
      setUsersError(errorMessage(error))
    } finally {
      setUsersLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadInvites()
    void loadUsers()
  }, [loadInvites, loadUsers])

  const createInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (creating) {
      return
    }

    const parsedMaxUses = Number(maxUses)
    if (!Number.isInteger(parsedMaxUses) || parsedMaxUses < 1) {
      setCreateError('使用次数必须是大于 0 的整数。')
      return
    }

    const parsedExpiry = expiresAt ? new Date(expiresAt).getTime() : null
    if (parsedExpiry !== null && (!Number.isFinite(parsedExpiry) || parsedExpiry <= Date.now())) {
      setCreateError('有效期必须晚于当前时间。')
      return
    }

    setCreating(true)
    setCreateError(null)
    setCreatedCode(null)
    setCopyStatus('idle')
    try {
      const result = await mutate<{ invite: Invite }>('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxUses: parsedMaxUses,
          ...(parsedExpiry === null ? {} : { expiresAt: parsedExpiry }),
        }),
      })
      setInvites((current) => [
        result.invite,
        ...current.filter((invite) => invite.id !== result.invite.id),
      ])
      setCreatedCode(result.invite.code)
      setCopyStatus('idle')
    } catch (error) {
      setCreateError(errorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  const deleteInvite = async (invite: Invite) => {
    const key = `invite-delete-${invite.id}`
    if (busyKey) {
      return
    }
    setBusyKey(key)
    setInvitesError(null)
    try {
      await mutate<unknown>(`/api/admin/invites/${encodeURIComponent(invite.id)}`, {
        method: 'DELETE',
      })
      setInvites((current) => current.filter((item) => item.id !== invite.id))
      setConfirmation(null)
    } catch (error) {
      setInvitesError(errorMessage(error))
    } finally {
      setBusyKey(null)
    }
  }

  const setUserStatus = async (user: AdminUser) => {
    const key = `user-status-${user.id}`
    if (busyKey) {
      return
    }
    setBusyKey(key)
    setUsersError(null)
    try {
      const result = await mutate<{ user: AdminUser }>(
        `/api/admin/users/${encodeURIComponent(user.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: user.status === 'active' ? 'disabled' : 'active',
          }),
        }
      )
      setUsers((current) => current.map((item) => (item.id === user.id ? result.user : item)))
    } catch (error) {
      setUsersError(errorMessage(error))
    } finally {
      setBusyKey(null)
    }
  }

  const resetPassword = async (user: AdminUser) => {
    const key = `user-password-${user.id}`
    if (busyKey) {
      return
    }
    if (newPassword.length < 10 || newPassword.length > 128) {
      setUsersError('新密码需为 10 至 128 个字符。')
      return
    }
    setBusyKey(key)
    setUsersError(null)
    try {
      const result = await mutate<{ user: AdminUser }>(
        `/api/admin/users/${encodeURIComponent(user.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: newPassword }),
        }
      )
      setUsers((current) => current.map((item) => (item.id === user.id ? result.user : item)))
      setPasswordUserId(null)
      setNewPassword('')
    } catch (error) {
      setUsersError(errorMessage(error))
    } finally {
      setBusyKey(null)
    }
  }

  const deleteUser = async (user: AdminUser) => {
    const key = `user-delete-${user.id}`
    if (busyKey) {
      return
    }
    setBusyKey(key)
    setUsersError(null)
    try {
      await mutate<unknown>(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
      })
      setUsers((current) => current.filter((item) => item.id !== user.id))
      setConfirmation(null)
      if (passwordUserId === user.id) {
        setPasswordUserId(null)
        setNewPassword('')
      }
    } catch (error) {
      setUsersError(errorMessage(error))
    } finally {
      setBusyKey(null)
    }
  }

  const deleteUserChats = async (user: AdminUser) => {
    const key = `user-chats-${user.id}`
    if (busyKey) {
      return
    }
    setBusyKey(key)
    setUsersError(null)
    try {
      await mutate<unknown>(`/api/admin/users/${encodeURIComponent(user.id)}/chats`, {
        method: 'DELETE',
      })
      setUsers((current) =>
        current.map((item) => (item.id === user.id ? { ...item, sessionCount: 0 } : item))
      )
      setConfirmation(null)
    } catch (error) {
      setUsersError(errorMessage(error))
    } finally {
      setBusyKey(null)
    }
  }

  const refreshCurrentTab = () => {
    if (tab === 'invites') {
      void loadInvites()
    } else {
      void loadUsers()
    }
  }

  const activeUsers = users.filter((user) => user.status === 'active').length
  const availableInvites = invites.filter(
    (invite) =>
      invite.uses < invite.maxUses && (invite.expiresAt === null || invite.expiresAt > Date.now())
  ).length

  return (
    <main className={variant === 'modal' ? styles.modalPage : styles.page}>
      {variant === 'page' ? (
        <header className={styles.topbar}>
          <div className={styles.topbarInner}>
            <div>
              <div className={styles.eyebrow}>私人部署</div>
              <h1 className={styles.heading}>管理控制台</h1>
            </div>
            <a className={styles.backLink} href="/">
              返回对话
            </a>
          </div>
        </header>
      ) : null}

      <div className={styles.content}>
        <section className={styles.overview} aria-label="账户概览">
          <div className={styles.metric}>
            <span className={styles.metricValue}>{users.length}</span>
            <span className={styles.metricLabel}>全部用户</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricValue}>{activeUsers}</span>
            <span className={styles.metricLabel}>正常账户</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricValue}>{availableInvites}</span>
            <span className={styles.metricLabel}>可用邀请码</span>
          </div>
        </section>

        <div className={styles.sectionHeader}>
          <div className={styles.tabs} role="tablist" aria-label="管理内容">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'invites'}
              className={styles.tab}
              onClick={() => setTab('invites')}
            >
              邀请码
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'users'}
              className={styles.tab}
              onClick={() => setTab('users')}
            >
              用户
            </button>
          </div>
          <Button variant="outlined" size="m" onClick={refreshCurrentTab}>
            刷新
          </Button>
        </div>

        {tab === 'invites' ? (
          <section className={styles.panel} role="tabpanel" aria-label="邀请码">
            <div className={styles.panelHeading}>
              <div>
                <h2 className={styles.panelTitle}>创建邀请码</h2>
                <p className={styles.panelDescription}>
                  为受信任的成员签发一次性或多次使用的账户邀请。
                </p>
              </div>
            </div>
            <form className={styles.inviteForm} onSubmit={(event) => void createInvite(event)}>
              <label className={styles.inlineField}>
                <span>使用次数</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={maxUses}
                  disabled={creating}
                  onChange={(event) => {
                    setMaxUses(event.target.value)
                    setCreateError(null)
                  }}
                />
              </label>
              <label className={styles.inlineField}>
                <span>到期时间</span>
                <input
                  type="datetime-local"
                  value={expiresAt}
                  min={toLocalInputValue(Date.now())}
                  disabled={creating}
                  onChange={(event) => {
                    setExpiresAt(event.target.value)
                    setCreateError(null)
                  }}
                />
                <span className={styles.fieldHint}>留空表示永久有效</span>
              </label>
              <Button type="submit" disabled={creating}>
                {creating ? '生成中…' : '生成邀请码'}
              </Button>
            </form>
            {createError ? (
              <div className={styles.alert} role="alert">
                {createError}
              </div>
            ) : null}
            {createdCode ? (
              <div className={styles.createdInvite} role="status">
                <span>邀请码已创建</span>
                <code>{createdCode}</code>
                <button
                  type="button"
                  className={styles.copyButton}
                  onClick={() => {
                    void copyText(createdCode).then((copied) => {
                      setCopyStatus(copied ? 'copied' : 'failed')
                    })
                  }}
                >
                  {copyStatus === 'copied'
                    ? '已复制'
                    : copyStatus === 'failed'
                      ? '复制失败'
                      : '复制'}
                </button>
              </div>
            ) : null}

            <div className={styles.listHeader}>
              <h3 className={styles.listTitle}>现有邀请码</h3>
              <span className={styles.listCount}>{invites.length} 个</span>
            </div>
            {invitesError ? (
              <div className={styles.alert} role="alert">
                <span>{invitesError}</span>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => void loadInvites()}
                >
                  重试
                </button>
              </div>
            ) : null}
            {invitesLoading ? (
              <div className={styles.empty} role="status">
                正在加载邀请码…
              </div>
            ) : invites.length === 0 ? (
              <div className={styles.empty}>还没有邀请码。</div>
            ) : (
              <div className={styles.tableScroller}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>邀请码</th>
                      <th>使用情况</th>
                      <th>有效期</th>
                      <th>创建时间</th>
                      <th>
                        <span className={styles.srOnly}>操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((invite) => {
                      const deleting =
                        confirmation?.kind === 'invite' && confirmation.id === invite.id
                      const expired = invite.expiresAt !== null && invite.expiresAt <= Date.now()
                      const usedUp = invite.uses >= invite.maxUses
                      return (
                        <tr key={invite.id}>
                          <td>
                            <div className={styles.inviteCode}>
                              <code title={invite.code === null ? '邀请记录 ID' : undefined}>
                                {invite.code ?? invite.id}
                              </code>
                              {expired || usedUp ? (
                                <span className={styles.badgeMuted}>
                                  {expired ? '已过期' : '已用完'}
                                </span>
                              ) : (
                                <span className={styles.badgeActive}>可用</span>
                              )}
                            </div>
                          </td>
                          <td>
                            {invite.uses} / {invite.maxUses}
                          </td>
                          <td>{formatExpiry(invite.expiresAt)}</td>
                          <td>{formatDateTime(invite.createdAt)}</td>
                          <td className={styles.actionCell}>
                            {deleting ? (
                              <div className={styles.inlineConfirm}>
                                <span>确认删除？</span>
                                <button
                                  type="button"
                                  className={styles.textButton}
                                  disabled={Boolean(busyKey)}
                                  onClick={() => setConfirmation(null)}
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  className={styles.dangerTextButton}
                                  disabled={Boolean(busyKey)}
                                  onClick={() => void deleteInvite(invite)}
                                >
                                  {busyKey?.startsWith('invite-delete-') ? '删除中…' : '删除'}
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className={styles.dangerTextButton}
                                disabled={Boolean(busyKey)}
                                onClick={() => setConfirmation({ kind: 'invite', id: invite.id })}
                              >
                                删除
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : (
          <section className={styles.panel} role="tabpanel" aria-label="用户">
            <div className={styles.panelHeading}>
              <div>
                <h2 className={styles.panelTitle}>账户与访问</h2>
                <p className={styles.panelDescription}>
                  管理账户状态、密码和聊天记录。敏感操作会在此处直接确认。
                </p>
              </div>
            </div>
            {usersError ? (
              <div className={styles.alert} role="alert">
                <span>{usersError}</span>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => void loadUsers()}
                >
                  重试
                </button>
              </div>
            ) : null}
            {usersLoading ? (
              <div className={styles.empty} role="status">
                正在加载用户…
              </div>
            ) : users.length === 0 ? (
              <div className={styles.empty}>还没有用户。</div>
            ) : (
              <div className={styles.tableScroller}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>身份</th>
                      <th>状态</th>
                      <th>聊天记录</th>
                      <th>创建时间</th>
                      <th>
                        <span className={styles.srOnly}>操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => {
                      const editingPassword = passwordUserId === user.id
                      const deleting = confirmation?.kind === 'user' && confirmation.id === user.id
                      const clearingChats =
                        confirmation?.kind === 'chats' && confirmation.id === user.id
                      const isCurrentAdmin = currentUser?.id === user.id && user.role === 'admin'
                      const rowBusy =
                        busyKey !== null &&
                        [
                          `user-status-${user.id}`,
                          `user-password-${user.id}`,
                          `user-delete-${user.id}`,
                          `user-chats-${user.id}`,
                        ].includes(busyKey)
                      return (
                        <UserRow
                          key={user.id}
                          user={user}
                          editingPassword={editingPassword}
                          deleting={deleting}
                          clearingChats={clearingChats}
                          rowBusy={rowBusy}
                          anyBusy={Boolean(busyKey)}
                          canToggleStatus={!isCurrentAdmin}
                          canResetPassword={user.role !== 'admin'}
                          canDelete={!isCurrentAdmin}
                          passwordId={editingPassword ? passwordInputId : undefined}
                          password={newPassword}
                          onPasswordChange={(value) => {
                            setNewPassword(value)
                            setUsersError(null)
                          }}
                          onStartPassword={() => {
                            setConfirmation(null)
                            setPasswordUserId(user.id)
                            setNewPassword('')
                            setUsersError(null)
                          }}
                          onCancelPassword={() => {
                            setPasswordUserId(null)
                            setNewPassword('')
                          }}
                          onSavePassword={() => void resetPassword(user)}
                          onToggleStatus={() => void setUserStatus(user)}
                          onDelete={() => setConfirmation({ kind: 'user', id: user.id })}
                          onCancelDelete={() => setConfirmation(null)}
                          onConfirmDelete={() => void deleteUser(user)}
                          onClearChats={() => setConfirmation({ kind: 'chats', id: user.id })}
                          onCancelClearChats={() => setConfirmation(null)}
                          onConfirmClearChats={() => void deleteUserChats(user)}
                        />
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  )
}

const UserRow = ({
  user,
  editingPassword,
  deleting,
  clearingChats,
  rowBusy,
  anyBusy,
  canToggleStatus,
  canResetPassword,
  canDelete,
  passwordId,
  password,
  onPasswordChange,
  onStartPassword,
  onCancelPassword,
  onSavePassword,
  onToggleStatus,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
  onClearChats,
  onCancelClearChats,
  onConfirmClearChats,
}: {
  user: AdminUser
  editingPassword: boolean
  deleting: boolean
  clearingChats: boolean
  rowBusy: boolean
  anyBusy: boolean
  canToggleStatus: boolean
  canResetPassword: boolean
  canDelete: boolean
  passwordId?: string
  password: string
  onPasswordChange: (value: string) => void
  onStartPassword: () => void
  onCancelPassword: () => void
  onSavePassword: () => void
  onToggleStatus: () => void
  onDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
  onClearChats: () => void
  onCancelClearChats: () => void
  onConfirmClearChats: () => void
}) => (
  <>
    <tr className={user.status === 'disabled' ? styles.disabledRow : undefined}>
      <td>
        <div className={styles.userCell}>
          <span className={styles.userAvatar} aria-hidden="true">
            {Array.from(user.username)[0]?.toLocaleUpperCase('zh-CN') ?? '用'}
          </span>
          <span className={styles.userName}>{user.username}</span>
        </div>
      </td>
      <td>{user.role === 'admin' ? '管理员' : '用户'}</td>
      <td>
        <span className={user.status === 'active' ? styles.badgeActive : styles.badgeMuted}>
          {user.status === 'active' ? '正常' : '已停用'}
        </span>
        {user.hasCustomApiKey ? <span className={styles.apiKeyNote}>自定义 API Key</span> : null}
      </td>
      <td>{user.sessionCount} 个会话</td>
      <td>{formatDateTime(user.createdAt)}</td>
      <td className={styles.actionCell}>
        <div className={styles.rowActions}>
          {canToggleStatus ? (
            <button
              type="button"
              className={styles.textButton}
              disabled={anyBusy}
              onClick={onToggleStatus}
            >
              {user.status === 'active' ? '停用' : '启用'}
            </button>
          ) : null}
          {canResetPassword ? (
            <button
              type="button"
              className={styles.textButton}
              disabled={anyBusy}
              onClick={editingPassword ? onCancelPassword : onStartPassword}
            >
              {editingPassword ? '取消改密' : '重置密码'}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.dangerTextButton}
            disabled={anyBusy}
            onClick={onClearChats}
          >
            清空记录
          </button>
          {canDelete ? (
            <button
              type="button"
              className={styles.dangerTextButton}
              disabled={anyBusy}
              onClick={onDelete}
            >
              删除用户
            </button>
          ) : null}
        </div>
      </td>
    </tr>
    {editingPassword ? (
      <tr>
        <td colSpan={6}>
          <div className={styles.inlineEditor}>
            <label htmlFor={passwordId}>为 {user.username} 设置新密码</label>
            <input
              id={passwordId}
              type="password"
              minLength={10}
              maxLength={128}
              autoComplete="new-password"
              value={password}
              disabled={anyBusy}
              onChange={(event) => onPasswordChange(event.target.value)}
            />
            <span className={styles.editorHint}>10 至 128 个字符</span>
            <button
              type="button"
              className={styles.confirmButton}
              disabled={anyBusy || password.length < 10 || password.length > 128}
              onClick={onSavePassword}
            >
              {rowBusy ? '保存中…' : '保存密码'}
            </button>
          </div>
        </td>
      </tr>
    ) : null}
    {deleting ? (
      <tr>
        <td colSpan={6}>
          <div className={styles.inlineConfirmRow} role="alert">
            <span>永久删除用户“{user.username}”及其全部数据？</span>
            <button
              type="button"
              className={styles.textButton}
              disabled={anyBusy}
              onClick={onCancelDelete}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.dangerTextButton}
              disabled={anyBusy}
              onClick={onConfirmDelete}
            >
              {rowBusy ? '删除中…' : '确认删除'}
            </button>
          </div>
        </td>
      </tr>
    ) : null}
    {clearingChats ? (
      <tr>
        <td colSpan={6}>
          <div className={styles.inlineConfirmRow} role="alert">
            <span>
              清空“{user.username}”的全部 {user.sessionCount} 个会话？此操作无法撤销。
            </span>
            <button
              type="button"
              className={styles.textButton}
              disabled={anyBusy}
              onClick={onCancelClearChats}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.dangerTextButton}
              disabled={anyBusy}
              onClick={onConfirmClearChats}
            >
              {rowBusy ? '清空中…' : '确认清空'}
            </button>
          </div>
        </td>
      </tr>
    ) : null}
  </>
)
