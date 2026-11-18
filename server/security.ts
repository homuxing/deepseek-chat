import { HTTPException } from 'hono/http-exception'

const encoder = new TextEncoder()
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

export const equalSecret = (actual: string, expected: string): boolean => {
  const left = encoder.encode(actual)
  const right = encoder.encode(expected)
  if (left.length !== right.length) {
    return false
  }
  let difference = 0
  for (let i = 0; i < left.length; i++) {
    difference |= left[i] ^ right[i]
  }
  return difference === 0
}

export const adminCredentialHash = async (username: string, password: string): Promise<string> => {
  const salt = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(JSON.stringify(['deepseek-chat-admin-session-v1', username]))
    )
  )
  return toBase64(await derivePassword(password, salt))
}

export const randomToken = (): string =>
  toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

export const sha256 = async (value: string): Promise<string> =>
  toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))

// Workers Web Crypto supports PBKDF2 with at most 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000

const derivePassword = async (password: string, salt: Uint8Array): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: salt as BufferSource,
        iterations: PASSWORD_ITERATIONS,
      },
      key,
      256
    )
  )
}

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${toBase64(salt)}$${toBase64(await derivePassword(password, salt))}`
}

export const verifyPassword = async (password: string, encoded: string): Promise<boolean> => {
  const [algorithm, iterations, salt, hash] = encoded.split('$')
  if (
    algorithm !== 'pbkdf2-sha256' ||
    iterations !== String(PASSWORD_ITERATIONS) ||
    !salt ||
    !hash
  ) {
    return false
  }
  try {
    const expected = fromBase64(hash)
    const actual = await derivePassword(password, fromBase64(salt))
    if (actual.length !== expected.length) {
      return false
    }
    let difference = 0
    for (let i = 0; i < actual.length; i++) {
      difference |= actual[i] ^ expected[i]
    }
    return difference === 0
  } catch {
    return false
  }
}

const encryptionKey = async (secret: string): Promise<CryptoKey> => {
  if (!secret || secret.length < 32) {
    throw new HTTPException(503, { message: '请配置至少 32 字符的 API_KEY_ENCRYPTION_KEY Secret' })
  }
  return crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', encoder.encode(secret)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  )
}

export const encryptApiKey = async (plaintext: string, secret: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    encoder.encode(plaintext)
  )
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`
}

export const decryptApiKey = async (ciphertext: string, secret: string): Promise<string> => {
  const [version, iv, data] = ciphertext.split('.')
  if (version !== 'v1' || !iv || !data) {
    throw new Error('Invalid encrypted API key')
  }
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) as BufferSource },
      await encryptionKey(secret),
      fromBase64(data) as BufferSource
    )
  )
}
