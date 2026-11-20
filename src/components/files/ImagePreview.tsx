import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import type { FileAttachment } from '../../services/chat/types.js'
import {
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconPhotoErrorFill20,
} from '../base/icons.js'
import { useFileResource } from './useFileResource.js'
import styles from './ImagePreview.module.css'

/** 原生 dialog 限制背景交互与焦点；预览卸载时恢复进入前的焦点。 */
export const ImagePreview = ({
  files,
  initialId,
  onClose,
}: {
  files: FileAttachment[]
  initialId: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [selectedId, setSelectedId] = useState(initialId)
  const index = files.findIndex((file) => file.id === selectedId)
  const file = files[index]

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [])

  const select = (offset: number) => {
    const next = files[index + offset]
    if (next) {
      // 切到首尾后按钮会禁用，先把焦点放回可用的关闭按钮，避免焦点脱离 dialog。
      dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      setSelectedId(next.id)
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className={styles.viewer}
      aria-label={t('imagePreview')}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => event.target === event.currentTarget && onClose()}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          // 在首尾按钮之间循环焦点，浏览器不能把 Tab 导向背景或地址栏。
          const controls =
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          } else if (!Array.from(controls).some((control) => control === document.activeElement)) {
            event.preventDefault()
            const target = event.shiftKey ? last : first
            target?.focus()
          }
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          select(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
    >
      <div className={styles.heading}>
        <span className={styles.name}>{file?.name}</span>
        {files.length > 1 ? (
          <span className={styles.counter} aria-live="polite">
            {index + 1} / {files.length}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.close}
        aria-label={t('close')}
        onClick={onClose}
        autoFocus
      >
        <IconCloseOutline16 />
      </button>
      <div className={styles.stage}>{file ? <PreviewImage key={file.id} file={file} /> : null}</div>
      {files.length > 1 ? (
        <>
          <button
            type="button"
            className={styles.previous}
            aria-label={t('previousImage')}
            disabled={index <= 0}
            onClick={() => select(-1)}
          >
            <IconChevronRightOutline14 />
          </button>
          <button
            type="button"
            className={styles.next}
            aria-label={t('nextImage')}
            disabled={index >= files.length - 1}
            onClick={() => select(1)}
          >
            <IconChevronRightOutline14 />
          </button>
        </>
      ) : null}
    </dialog>,
    document.body
  )
}

const PreviewImage = ({ file }: { file: FileAttachment }) => {
  const t = useTranslate()
  const resource = useFileResource(file.id)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const url = resource.status === 'ready' ? resource.url : null
  const failed = resource.status === 'error' || (url !== null && failedUrl === url)
  const missing = resource.status === 'missing'
  return (
    <>
      {url && !failed ? (
        <img
          className={styles.image}
          src={url}
          alt={file.name}
          onLoad={() => setLoadedUrl(url)}
          onError={() => setFailedUrl(url)}
          style={loadedUrl === url ? undefined : { visibility: 'hidden' }}
        />
      ) : null}
      {failed || missing ? (
        <div className={styles.status} role="alert">
          <IconPhotoErrorFill20 />
          <span>{t(missing ? 'imageMissing' : 'imageLoadFailed')}</span>
        </div>
      ) : resource.status === 'loading' || loadedUrl !== url ? (
        <div className={styles.status} role="status">
          <span className={styles.spinner} />
          <span>{t('imageLoading')}</span>
        </div>
      ) : null}
    </>
  )
}
