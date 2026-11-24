import { create } from 'zustand'

export type HistoryImportPhase = 'idle' | 'checking' | 'uploading' | 'committing' | 'done' | 'error'

export type HistoryImportProgress = {
  phase: HistoryImportPhase
  sessions: number
  files: number
  error?: string
}

const createInitialState = (): HistoryImportProgress => ({
  phase: 'idle',
  sessions: 0,
  files: 0,
})

/**
 * 导入状态独立于设置弹窗保存，组件卸载不会中断任务，
 * 进度弹窗与关闭保护共同读取当前阶段和计数。
 */
export const useHistoryImportProgress = create<HistoryImportProgress>(createInitialState)

/** 主流程按导入阶段增量更新；进入非 error 阶段时清除上一次错误。 */
export const setHistoryImportProgress = (progress: Partial<HistoryImportProgress>): void => {
  useHistoryImportProgress.setState((current) => {
    const next = { ...current, ...progress }
    if (progress.phase && progress.phase !== 'error') {
      delete next.error
    }
    return next
  }, true)
}

export const resetHistoryImportProgress = (): void => {
  useHistoryImportProgress.setState(createInitialState(), true)
}

export const isHistoryImportActive = (phase: HistoryImportPhase): boolean =>
  phase === 'checking' || phase === 'uploading' || phase === 'committing'
