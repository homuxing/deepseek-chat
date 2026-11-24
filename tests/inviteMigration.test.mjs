import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { migrateInviteCodes } from '../scripts/migrate-invite-codes.mjs'

const secret = 'invite-migration-test-key-with-at-least-32-characters'
const hash = (code) => createHash('sha256').update(code).digest('base64')
const encryptedCode = (code, id) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
  cipher.setAAD(Buffer.from(JSON.stringify(['deepseek-chat-invite-v1', id])))
  const data = Buffer.concat([cipher.update(code), cipher.final(), cipher.getAuthTag()])
  return `v1.${iv.toString('base64')}.${data.toString('base64')}`
}
const setup = () => {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(`migrations/${file}`, 'utf8'))
  }
  db.exec(
    "INSERT INTO users (id, username, role, created_at) VALUES ('admin', 'admin', 'admin', 1)"
  )
  const add = (id, code, ciphertext = encryptedCode(code, id)) => {
    db.prepare(
      'INSERT INTO invites (id, code_hash, code_ciphertext, max_uses, uses, expires_at, created_by, created_at) VALUES (?, ?, ?, 5, 2, 9999999999999, ?, 123)'
    ).run(id, hash(code), ciphertext, 'admin')
  }
  const database = {
    query: async (sql) => db.prepare(sql).all(),
    execute: async (sql) => {
      db.exec('BEGIN')
      try {
        db.exec(sql)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db, add, database }
}

test('邀请码原码迁移保留哈希、次数、期限和历史记录，发布后清除密文且可重复执行', async () => {
  const { db, add, database } = setup()
  try {
    add('encrypted', 'a-random-invite-code')
    add('legacy', 'legacy-code', null)
    const before = db.prepare('SELECT * FROM invites ORDER BY id').all()
    assert.equal(await migrateInviteCodes(database, secret), 1)
    const migrated = db.prepare("SELECT * FROM invites WHERE id = 'encrypted'").get()
    assert.deepEqual({ ...migrated }, { ...before[0], code: 'a-random-invite-code' })
    assert.deepEqual(db.prepare("SELECT * FROM invites WHERE id = 'legacy'").get(), before[1])
    assert.equal(await migrateInviteCodes(database, undefined, { clearCiphertext: true }), 1)
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM invites WHERE id = 'encrypted'").get() },
      { ...migrated, code_ciphertext: null }
    )
    assert.equal(await migrateInviteCodes(database, undefined, { clearCiphertext: true }), 0)
  } finally {
    db.close()
  }
})

test('缺少原密钥、密文损坏或哈希不一致时不写入任何原码，修正后可迁移', async () => {
  const { db, add, database } = setup()
  try {
    add('valid', 'valid-code')
    add('damaged', 'damaged-code')
    const original = db.prepare('SELECT * FROM invites ORDER BY id').all()
    for (const invalidSecret of [undefined, 'short', 'x'.repeat(43)]) {
      await assert.rejects(migrateInviteCodes(database, invalidSecret))
      assert.deepEqual(db.prepare('SELECT * FROM invites ORDER BY id').all(), original)
    }
    for (const badCiphertext of [
      'broken',
      encryptedCode('wrong-code', 'damaged'),
      encryptedCode('damaged-code', 'valid'),
    ]) {
      db.prepare("UPDATE invites SET code_ciphertext = ? WHERE id = 'damaged'").run(badCiphertext)
      await assert.rejects(migrateInviteCodes(database, secret))
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM invites WHERE code IS NOT NULL').get().n,
        0
      )
    }
    db.prepare("UPDATE invites SET code_ciphertext = ? WHERE id = 'damaged'").run(
      original[0].code_ciphertext
    )
    assert.equal(await migrateInviteCodes(database, secret, { clearCiphertext: true }), 2)
  } finally {
    db.close()
  }
})

test('邀请码迁移遇到数据库失败时保留原记录，恢复后可继续', async () => {
  const { db, add, database } = setup()
  try {
    add('stored', 'stored-code')
    const before = db.prepare('SELECT * FROM invites').get()
    await assert.rejects(
      migrateInviteCodes(
        {
          ...database,
          query: async () => {
            throw new Error('读取失败')
          },
        },
        secret
      ),
      /读取失败/
    )
    await assert.rejects(
      migrateInviteCodes(
        {
          ...database,
          execute: async () => {
            throw new Error('写入失败')
          },
        },
        secret
      ),
      /写入失败/
    )
    assert.deepEqual(db.prepare('SELECT * FROM invites').get(), before)
    assert.equal(await migrateInviteCodes(database, secret, { clearCiphertext: true }), 1)
  } finally {
    db.close()
  }
})

test('邀请码迁移保留并发使用次数和删除结果，并识别迁移期间新增的密文', async () => {
  const { db, add, database } = setup()
  try {
    add('used', 'used-code')
    add('deleted', 'deleted-code')
    await migrateInviteCodes(
      {
        ...database,
        execute: async (sql) => {
          db.exec(
            "UPDATE invites SET uses = 3 WHERE id = 'used'; DELETE FROM invites WHERE id = 'deleted'"
          )
          await database.execute(sql)
        },
      },
      secret
    )
    assert.equal(db.prepare("SELECT uses FROM invites WHERE id = 'used'").get().uses, 3)
    assert.equal(db.prepare("SELECT id FROM invites WHERE id = 'deleted'").get(), undefined)
    await assert.rejects(
      migrateInviteCodes(
        {
          ...database,
          execute: async (sql) => {
            await database.execute(sql)
            add('during-publish', 'during-publish-code')
          },
        },
        secret,
        { clearCiphertext: true }
      ),
      /未完成/
    )
    assert.equal(await migrateInviteCodes(database, secret, { clearCiphertext: true }), 1)
    assert.equal(
      db.prepare("SELECT code FROM invites WHERE id = 'during-publish'").get().code,
      'during-publish-code'
    )
  } finally {
    db.close()
  }
})
