import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('test-results', { recursive: true })
await build({
  stdin: {
    contents:
      "export * from './src/services/api/client.ts'; export * from './src/services/backend.ts'",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: 'test-results/apiKey.mjs',
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
})
const { saveCustomApiKey, clearCustomApiKey, setBackendUserId } =
  await import('../test-results/apiKey.mjs')
const originalFetch = globalThis.fetch
after(() => {
  globalThis.fetch = originalFetch
  setBackendUserId(null)
})

test('保存仅发送一次请求并确认已保存标记，API Key 不进入 URL 或鉴权头', async () => {
  const key = `sk-${'12'.repeat(16)}`
  const requests = []
  setBackendUserId('current-user')
  globalThis.fetch = async (path, init) => {
    requests.push({ path, ...init })
    return Response.json({ hasCustomApiKey: true })
  }
  await saveCustomApiKey(key)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/settings/api-key')
  assert.equal(requests[0].method, 'PUT')
  assert.deepEqual(JSON.parse(requests[0].body), { apiKey: key })
  assert.equal(requests[0].headers.get('X-Chat-User-ID'), 'current-user')
  assert.equal(requests[0].headers.get('Authorization'), null)
  assert.equal(requests[0].headers.get('x-api-key'), null)
  assert.equal(requests[0].headers.get('X-Requested-With'), 'XMLHttpRequest')
})

test('保存或清除响应异常时如实失败，不将 HTML、空数据或失败标记视为成功', async () => {
  for (const response of [
    () => new Response('<html>Sign in</html>'),
    () => new Response(null, { status: 204 }),
    () => Response.json({ hasCustomApiKey: false }),
    () => Response.json({ error: { message: 'failed' } }),
  ]) {
    globalThis.fetch = async () => response()
    await assert.rejects(saveCustomApiKey('sk-candidate'), (error) => error.kind === 'protocol')
  }
  globalThis.fetch = async () => new Response('<html>Sign in</html>')
  await assert.rejects(clearCustomApiKey(), (error) => error.kind === 'protocol')
  globalThis.fetch = async () => new Response(null, { status: 204 })
  await clearCustomApiKey()
})

test('无效 API Key、配置错误与网络错误保留失败类别和状态', async () => {
  for (const status of [401, 503]) {
    globalThis.fetch = async () =>
      Response.json({ error: { message: 'key operation failed' } }, { status })
    await assert.rejects(
      saveCustomApiKey('sk-candidate'),
      (error) => error.status === status && error.kind === 'http'
    )
  }
  globalThis.fetch = async () => {
    throw new TypeError('network unavailable')
  }
  await assert.rejects(saveCustomApiKey('sk-candidate'), (error) => error.kind === 'network')
})
