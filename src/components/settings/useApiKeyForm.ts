import { useRef, useState } from 'react'
import { ApiError, clearCustomApiKey, saveCustomApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { getBackendUserId } from '../../services/backend.js'
import { setApiKey } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

type FailureAction = 'save' | 'clear'
type Failure = { cause: unknown; action: FailureAction }

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** 服务端完成校验和保存，前端只保留已配置标记。 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const submitting = useRef(false)

  const describeFailure = (current: Failure): string => {
    const condition = classifyApiError(current.cause)
    if (condition === 'unauthorized') {
      return t('apiKeyInvalid')
    }
    if (condition === 'network') {
      return t('commonNetworkErrorToast')
    }
    const message =
      current.cause instanceof ApiError && current.cause.localMessage
        ? t(current.cause.localMessage.key, current.cause.localMessage.params)
        : errorMessage(current.cause)
    if (current.action === 'clear') {
      return t('apiKeyClearFailed', { message })
    }
    return t('apiKeySaveFailed', { message })
  }

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || submitting.current) {
      return
    }
    submitting.current = true
    const userId = getBackendUserId()
    setBusy(true)
    setFailure(null)
    try {
      await saveCustomApiKey(apiKey)
      if (getBackendUserId() !== userId) {
        return
      }
      setApiKey('configured')
      setValue('')
      onSaved?.()
    } catch (cause) {
      if (getBackendUserId() === userId) {
        setFailure({ cause, action: 'save' })
      }
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const clear = async () => {
    if (submitting.current) {
      return
    }
    submitting.current = true
    const userId = getBackendUserId()
    setBusy(true)
    setFailure(null)
    try {
      await clearCustomApiKey()
      if (getBackendUserId() !== userId) {
        return
      }
      setApiKey(null)
      setValue('')
      onSaved?.()
    } catch (cause) {
      if (getBackendUserId() === userId) {
        setFailure({ cause, action: 'clear' })
      }
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return {
    value,
    setValue,
    verifying: busy,
    error: failure ? describeFailure(failure) : null,
    submit,
    clear,
  }
}
