import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { IconEyeOutline16 } from '../base/icons.js'
import styles from './PasswordInput.module.css'

export const PasswordInput = ({
  disabled,
  ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'type'>) => {
  const [revealed, setRevealed] = useState(false)
  const pointerId = useRef<number | null>(null)
  const heldKey = useRef<string | null>(null)

  const hide = () => {
    pointerId.current = null
    heldKey.current = null
    setRevealed(false)
  }

  useEffect(() => {
    // 窗口失焦或页面隐藏时可能收不到释放事件，必须立即隐藏密码。
    const onVisibilityChange = () => {
      if (document.hidden) {
        hide()
      }
    }
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (disabled) {
      hide()
    }
  }, [disabled])

  return (
    <div className={styles.root}>
      <input {...props} type={revealed && !disabled ? 'text' : 'password'} disabled={disabled} />
      <button
        type="button"
        className={styles.reveal}
        aria-label="按住查看密码"
        aria-controls={props.id}
        title="按住查看密码"
        disabled={disabled}
        onPointerDown={(event) => {
          if (event.button !== 0 || pointerId.current !== null) {
            return
          }
          event.preventDefault()
          // Pointer Capture 保证移出图标后松开也能收到释放事件。
          event.currentTarget.setPointerCapture(event.pointerId)
          pointerId.current = event.pointerId
          setRevealed(true)
        }}
        onPointerUp={(event) => {
          if (event.pointerId === pointerId.current) {
            hide()
          }
        }}
        onPointerCancel={hide}
        onLostPointerCapture={hide}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            if (!event.repeat) {
              heldKey.current = event.key
              setRevealed(true)
            }
          }
        }}
        onKeyUp={(event) => {
          if (event.key === heldKey.current) {
            event.preventDefault()
            hide()
          }
        }}
        onBlur={hide}
        onClick={(event) => event.preventDefault()}
      >
        <IconEyeOutline16 />
      </button>
    </div>
  )
}
