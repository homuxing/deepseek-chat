import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('test-results', { recursive: true })
await build({
  stdin: {
    contents: "export * from './src/services/chat/importProgress.ts'",
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
} = await import('../test-results/importProgress.mjs')

after(resetHistoryImportProgress)

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
