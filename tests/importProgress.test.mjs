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

test('检查、上传和提交期间禁止关闭设置，结束后恢复关闭', () => {
  for (const phase of ['preparing', 'checking', 'uploading', 'committing']) {
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
  setHistoryImportProgress({ phase: 'uploading', sessions: 12, files: 3 })
  assert.deepEqual(useHistoryImportProgress.getState(), {
    phase: 'uploading',
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

test('准备进度与断网等待属于进行状态，完成后清除临时状态', () => {
  setHistoryImportProgress({ phase: 'preparing', preparedPercent: 35, sessions: 0, files: 0 })
  assert.equal(isHistoryImportActive('preparing'), true)
  setHistoryImportProgress({ phase: 'uploading', sessions: 3, files: 2, waiting: true })
  assert.equal(useHistoryImportProgress.getState().preparedPercent, undefined)
  assert.equal(useHistoryImportProgress.getState().waiting, true)
  openSettings('data')
  closeSettings()
  assert.equal(useSettingsDialog.getState().open, true)
  setHistoryImportProgress({ waiting: undefined })
  assert.equal(useHistoryImportProgress.getState().waiting, undefined)
  assert.equal(useHistoryImportProgress.getState().sessions, 3)
  resetHistoryImportProgress()
  closeSettings()
})
