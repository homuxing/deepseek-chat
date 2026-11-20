import clsx from 'clsx'
import { useLayoutEffect, useRef } from 'react'
import { IconPanelLeftOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import styles from './Sider.module.css'

/** 收起后左上角的按钮组 */
export const CollapsedSider = ({ collapsed }: { collapsed: boolean }) => {
  const t = useTranslate()
  const containerRef = useRef<HTMLDivElement>(null)
  const previousCollapsed = useRef(collapsed)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container) {
      container.inert = !collapsed
      if (collapsed && !previousCollapsed.current) {
        container.querySelector<HTMLButtonElement>('button')?.focus()
      }
    }
    previousCollapsed.current = collapsed
  }, [collapsed])

  return (
    <div
      ref={containerRef}
      className={clsx(styles.collapsed, collapsed && styles.collapsedVisible)}
      aria-hidden={!collapsed}
    >
      <div className={styles.collapsedGroup}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('expandSiderbarButton')}
          aria-expanded={false}
          aria-controls="desktop-sider"
          onClick={() => setSiderCollapsed(false)}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          onClick={newChat}
        />
      </div>
    </div>
  )
}
