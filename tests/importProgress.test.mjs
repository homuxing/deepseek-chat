import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('test-results', { recursive: true })
await build({
  stdin: {
    contents:
      "export * from './src/services/chat/importProgress.ts'; export * from './src/components/settings/settingsDialogState.ts'",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: 'test-results/importProgress.mjs',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
})
const {
  isHistoryImportActive,
  resetHistoryImportProgress,
  setHistoryImportProgress,
  useHistoryImportProgress,
  openSettings,
  closeSettings,
  useSettingsDialog,
} = await import('../test-results/importProgress.mjs')

after(resetHistoryImportProgress)

test('检查、上传、处理和提交期间禁止关闭设置，结束后恢复关闭', () => {
  for (const phase of ['checking', 'uploading', 'processing', 'committing']) {
    setHistoryImportProgress({ phase })
    openSettings('data')
    closeSettings()
    assert.equal(useSettingsDialog.getState().open, true)
  }
  for (const phase of ['done', 'error', 'idle']) {
    setHistoryImportProgress({ phase })
    closeSettings()
    assert.equal(useSettingsDialog.getState().open, false)
    openSettings('data')
  }
  resetHistoryImportProgress()
  closeSettings()
})

test('导入状态从空闲开始', () => {
  resetHistoryImportProgress()
  assert.deepEqual(useHistoryImportProgress.getState(), {
    phase: 'idle',
    sessions: 0,
    files: 0,
  })
})

test('主流程可增量更新阶段和计数，进入新阶段会清除旧错误', () => {
  setHistoryImportProgress({ phase: 'processing', sessions: 12, files: 3 })
  assert.deepEqual(useHistoryImportProgress.getState(), {
    phase: 'processing',
    sessions: 12,
    files: 3,
  })
  assert.equal(isHistoryImportActive(useHistoryImportProgress.getState().phase), true)

  setHistoryImportProgress({ phase: 'error', error: 'network unavailable' })
  assert.equal(useHistoryImportProgress.getState().error, 'network unavailable')

  setHistoryImportProgress({ sessions: 18 })
  assert.equal(useHistoryImportProgress.getState().sessions, 18)
  assert.equal(useHistoryImportProgress.getState().error, 'network unavailable')

  setHistoryImportProgress({ phase: 'committing' })
  assert.deepEqual(useHistoryImportProgress.getState(), {
    phase: 'committing',
    sessions: 18,
    files: 3,
  })
})

test('成功状态保留计数，重置后清除全部导入状态', () => {
  setHistoryImportProgress({ phase: 'done', sessions: 18, files: 5 })
  assert.equal(isHistoryImportActive(useHistoryImportProgress.getState().phase), false)
  assert.deepEqual(useHistoryImportProgress.getState(), {
    phase: 'done',
    sessions: 18,
    files: 5,
  })

  resetHistoryImportProgress()
  assert.deepEqual(useHistoryImportProgress.getState(), {
    phase: 'idle',
    sessions: 0,
    files: 0,
  })
  assert.equal(isHistoryImportActive(useHistoryImportProgress.getState().phase), false)
})

test('处理阶段保留真实总数，上传阶段保持不确定且新导入清空旧状态', () => {
  setHistoryImportProgress({
    phase: 'processing',
    sessions: 3,
    files: 2,
    totalSessions: 10,
    totalFiles: 5,
    waiting: true,
  })
  let state = useHistoryImportProgress.getState()
  assert.equal(state.phase, 'processing')
  assert.equal(state.totalSessions, 10)
  assert.equal(state.totalFiles, 5)
  assert.equal(state.waiting, true)
  openSettings('data')
  closeSettings()
  assert.equal(useSettingsDialog.getState().open, true)

  setHistoryImportProgress({ waiting: undefined })
  assert.equal(useHistoryImportProgress.getState().waiting, undefined)

  setHistoryImportProgress({
    phase: 'uploading',
    sessions: 18,
    files: 12,
    totalSessions: 30,
    totalFiles: 20,
    preparedPercent: 80,
  })
  state = useHistoryImportProgress.getState()
  assert.equal(state.preparedPercent, 80)
  setHistoryImportProgress({ phase: 'processing' })
  assert.equal(useHistoryImportProgress.getState().preparedPercent, undefined)
  assert.equal(state.totalSessions, 30)

  setHistoryImportProgress({ phase: 'error', error: 'read failed' })
  resetHistoryImportProgress()
  assert.deepEqual(useHistoryImportProgress.getState(), {
    phase: 'idle',
    sessions: 0,
    files: 0,
  })
  closeSettings()
})
