import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = process.cwd()
const helperUrl = pathToFileURL(join(projectRoot, 'tests/helpers/workerCloudHarness.mjs')).href

const runInFreshProject = (body) => {
  const testRoot = join(projectRoot, 'test-results')
  mkdirSync(testRoot, { recursive: true })
  const directory = mkdtempSync(join(testRoot, 'worker-cloud-setup-'))
  try {
    // 独立进程绑定全新工作目录，避免开发目录已有的 tmp 掩盖初始化缺陷。
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
        import assert from 'node:assert/strict'
        import { cpSync, existsSync } from 'node:fs'
        import { join } from 'node:path'
        import { buildWorkerCloudBundle, removeWorkerCloudBundle } from ${JSON.stringify(helperUrl)}
        const sourceDirectory = ${JSON.stringify(join(projectRoot, 'server'))}
        const sharedDirectory = ${JSON.stringify(join(projectRoot, 'shared'))}
        const temporaryDirectory = join(process.cwd(), 'tmp')
        assert.equal(existsSync(temporaryDirectory), false)
        ${body}
      `,
      ],
      { cwd: directory, encoding: 'utf8', timeout: 30_000 }
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('全新工作目录可准备 Worker，并发调用共享构建结果且清理后可再次构建', () => {
  runInFreshProject(`
    cpSync(sourceDirectory, join(process.cwd(), 'server'), { recursive: true })
    cpSync(sharedDirectory, join(process.cwd(), 'shared'), { recursive: true })
    const [first, concurrent] = await Promise.all([
      buildWorkerCloudBundle(),
      buildWorkerCloudBundle(),
    ])
    assert.equal(first.outputFile, concurrent.outputFile)
    assert.equal(existsSync(first.outputFile), true)
    await removeWorkerCloudBundle()
    assert.equal(existsSync(first.outputDirectory), false)
    const rebuilt = await buildWorkerCloudBundle()
    assert.equal(existsSync(rebuilt.outputFile), true)
    await removeWorkerCloudBundle()
    assert.equal(existsSync(rebuilt.outputDirectory), false)
  `)
})

test('Worker 构建失败只报告原错误，清理正常完成且修正输入后可再次构建', () => {
  runInFreshProject(`
    await assert.rejects(buildWorkerCloudBundle(), /Could not resolve/)
    await removeWorkerCloudBundle()
    cpSync(sourceDirectory, join(process.cwd(), 'server'), { recursive: true })
    cpSync(sharedDirectory, join(process.cwd(), 'shared'), { recursive: true })
    const rebuilt = await buildWorkerCloudBundle()
    assert.equal(existsSync(rebuilt.outputFile), true)
    await removeWorkerCloudBundle()
    assert.equal(existsSync(rebuilt.outputDirectory), false)
  `)
})
