import { createDecipheriv, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

const codeHash = (code) => createHash('sha256').update(code).digest('base64')
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`

export const prepareInviteCodeUpdates = (rows, secret, { clearCiphertext = false } = {}) => {
  // 先验证全部原码再写入，密钥错误或密文损坏时保留原数据并停止发布。
  return rows.map((row) => {
    let code = row.code
    if (code === null) {
      if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error('转换已有邀请码需要原 API_KEY_ENCRYPTION_KEY，请提供密钥文件')
      }
      try {
        const [version, iv, encrypted, extra] = row.code_ciphertext.split('.')
        if (version !== 'v1' || !iv || !encrypted || extra !== undefined) {
          throw new Error('密文格式无效')
        }
        const payload = Buffer.from(encrypted, 'base64')
        const decipher = createDecipheriv(
          'aes-256-gcm',
          createHash('sha256').update(secret).digest(),
          Buffer.from(iv, 'base64')
        )
        decipher.setAAD(Buffer.from(JSON.stringify(['deepseek-chat-invite-v1', row.id])))
        decipher.setAuthTag(payload.subarray(-16))
        code = Buffer.concat([
          decipher.update(payload.subarray(0, -16)),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        throw new Error('无法转换已有邀请码，请检查原加密密钥和数据库记录')
      }
    }
    if (typeof code !== 'string' || !code || codeHash(code) !== row.code_hash) {
      throw new Error('邀请码原码与注册校验记录不一致，已停止转换')
    }
    // 发布前保留密文供旧运行版本读取，发布后清理；匹配记录状态，避免覆盖并发修改。
    return `UPDATE invites SET code = ${sqlString(code)}${clearCiphertext ? ', code_ciphertext = NULL' : ''}
      WHERE id = ${sqlString(row.id)} AND code_hash = ${sqlString(row.code_hash)}
        AND code_ciphertext = ${sqlString(row.code_ciphertext)}
        AND (code IS NULL OR code = ${sqlString(code)});`
  })
}

export const migrateInviteCodes = async (database, secret, { clearCiphertext = false } = {}) => {
  const pendingSql =
    'SELECT id, code_hash, code_ciphertext, code FROM invites WHERE code_ciphertext IS NOT NULL'
  const rows = await database.query(pendingSql)
  const updates = prepareInviteCodeUpdates(rows, secret, { clearCiphertext })
  if (updates.length > 0) {
    await database.execute(updates.join('\n'))
    const remaining = await database.query(pendingSql)
    if (
      remaining.some(
        (row) => clearCiphertext || row.code === null || codeHash(row.code) !== row.code_hash
      )
    ) {
      throw new Error('邀请码转换期间存在未完成的记录，已停止发布')
    }
  }
  return updates.length
}

const main = async () => {
  const args = process.argv.slice(2)
  const target = args[0]
  if (!['--local', '--remote'].includes(target)) {
    throw new Error('请选择 --local 或 --remote，可用 --key-file 指定原加密密钥文件')
  }
  const keyFileIndex = args.indexOf('--key-file')
  if (keyFileIndex !== -1 && !args[keyFileIndex + 1]) {
    throw new Error('--key-file 需要填写文件路径')
  }
  const keyFile =
    keyFileIndex === -1
      ? target === '--remote'
        ? '.env.production.encryption'
        : '.dev.vars'
      : args[keyFileIndex + 1]
  if (keyFileIndex !== -1 && !existsSync(keyFile)) {
    throw new Error('指定的原加密密钥文件不存在')
  }
  const secret = existsSync(keyFile)
    ? parseEnv(readFileSync(keyFile, 'utf8')).API_KEY_ENCRYPTION_KEY
    : process.env.API_KEY_ENCRYPTION_KEY
  const temporaryRoot = resolve('tmp')
  mkdirSync(temporaryRoot, { recursive: true })
  const temporaryDirectory = mkdtempSync(join(temporaryRoot, 'invite-migration-'))
  try {
    const run = (options, readResults = true) => {
      const result = spawnSync(
        process.execPath,
        [
          resolve('node_modules/wrangler/wrangler-dist/cli.js'),
          'd1',
          'execute',
          'DB',
          target,
          '--config',
          'wrangler.jsonc',
          '--json',
          ...options,
        ],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...process.env,
            WRANGLER_SEND_METRICS: 'false',
            WRANGLER_LOG_PATH: join(temporaryDirectory, 'wrangler.log'),
          },
        }
      )
      // Wrangler 输出可能包含 SQL 和原码，失败时只报告操作状态。
      if (result.error || result.status !== 0) {
        throw new Error('D1 邀请码迁移操作失败，请检查数据库连接和执行权限')
      }
      // 文件导入会输出进度文本；写入以退出状态和随后读取的数据库结果共同确认。
      if (!readResults) {
        return
      }
      const batches = JSON.parse(result.stdout)
      if (!Array.isArray(batches) || !batches.length || batches.some((batch) => !batch.success)) {
        throw new Error('D1 邀请码迁移未成功完成')
      }
      return batches.flatMap((batch) => batch.results ?? [])
    }
    const converted = await migrateInviteCodes(
      {
        query: async (sql) => run(['--command', sql]),
        execute: async (sql) => {
          const file = join(temporaryDirectory, 'convert.sql')
          writeFileSync(file, sql, { mode: 0o600 })
          run(['--file', file, '--yes'], false)
        },
      },
      secret,
      { clearCiphertext: args.includes('--clear-ciphertext') }
    )
    console.log(`邀请码原码迁移完成，转换 ${converted} 条记录。`)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
