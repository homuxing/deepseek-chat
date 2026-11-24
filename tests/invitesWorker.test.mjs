import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerCloudHarness, removeWorkerCloudBundle } from './helpers/workerCloudHarness.mjs'

test('真实 Worker 保存并读取原邀请码，并发注册严格遵守次数上限', { timeout: 60_000 }, async () => {
  const harness = await createWorkerCloudHarness()
  try {
    const migrated = await harness.initialize()
    assert.ok(migrated.applied.includes('0005_invite_codes.sql'))
    const anonymous = { cookie: '' }
    const login = await harness.api(anonymous, '/api/admin/login', {
      method: 'POST',
      body: { username: 'worker_cloud_admin', password: 'worker-cloud-admin-password' },
    })
    assert.equal(login.status, 200, await login.clone().text())
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const admin = { cookie }
    const { response, value } = await harness.expectApi(admin, '/api/admin/invites', {
      method: 'POST',
      body: { maxUses: 2 },
    })
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const invite = value.invite
    assert.notEqual(invite.code, invite.id)
    const registration = (username) =>
      harness.api(anonymous, '/api/auth/register', {
        method: 'POST',
        body: { username, password: 'a-worker-test-password', inviteCode: invite.code },
      })
    assert.equal((await registration('invite_first')).status, 201)
    assert.equal((await registration('INVITE_FIRST')).status, 409)
    const attempts = await Promise.all([
      registration('invite_second'),
      registration('invite_third'),
    ])
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 400])
    const listed = await harness.expectApi(admin, '/api/admin/invites')
    assert.equal(listed.response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(listed.value.invites, [{ ...invite, uses: 2 }])
    const [stored] = await harness.query('SELECT * FROM invites WHERE id = ?', [invite.id])
    assert.equal(stored.uses, 2)
    assert.match(stored.code_ciphertext, /^v1\./)
    assert.ok(!JSON.stringify(stored).includes(invite.code))
    const [accounts] = await harness.query(
      "SELECT COUNT(*) AS n FROM users WHERE username IN ('invite_first', 'invite_second', 'invite_third')"
    )
    assert.equal(accounts.n, 2)
    const rejected = await harness.api(anonymous, '/api/admin/invites')
    assert.equal(rejected.status, 401)
  } finally {
    await harness.dispose()
  }
})

test.after(removeWorkerCloudBundle)
