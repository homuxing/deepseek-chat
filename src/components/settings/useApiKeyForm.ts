import { useState } from 'react'
import {
  ApiError,
  clearCustomApiKey,
  saveCustomApiKey,
  verifyApiKey,
} from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiKey } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

type FailureAction = 'verify' | 'save' | 'clear'
type Failure = { cause: unknown; action: FailureAction }

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** Verify a candidate key, save it server-side, and keep only a configured marker in memory. */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

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
    if (current.action === 'save') {
      return t('apiKeySaveFailed', { message })
    }
    return t('apiKeyVerificationFailed', { message })
  }

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || busy) {
      return
    }
    let action: FailureAction = 'verify'
    setBusy(true)
    setFailure(null)
    try {
      await verifyApiKey(apiKey)
      action = 'save'
      await saveCustomApiKey(apiKey)
      setApiKey('configured')
      setValue('')
      onSaved?.()
    } catch (cause) {
      setFailure({ cause, action })
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await clearCustomApiKey()
      setApiKey(null)
      setValue('')
      onSaved?.()
    } catch (cause) {
      setFailure({ cause, action: 'clear' })
    } finally {
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
