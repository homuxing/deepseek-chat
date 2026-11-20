import { useCallback, useSyncExternalStore } from 'react'
import { getFileResource, subscribeFileResource } from '../../services/chat/fileResources.js'

export const useFileResource = (id: string) =>
  useSyncExternalStore(
    useCallback((listener: () => void) => subscribeFileResource(id, listener), [id]),
    useCallback(() => getFileResource(id), [id])
  )
