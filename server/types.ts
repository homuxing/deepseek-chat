export type UserRow = {
  id: string
  username: string
  password_hash: string | null
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  api_key_ciphertext: string | null
  created_at: number
  access_sub: string | null
}

export type Bindings = {
  DB: D1Database
  FILES: R2Bucket
  ASSETS: Fetcher
  DEEPSEEK_API_KEY: string
  API_KEY_ENCRYPTION_KEY: string
  CF_ACCESS_TEAM_DOMAIN: string
  CF_ACCESS_AUD: string
  ADMIN_EMAILS: string
  APP_ORIGIN?: string
  DEEPSEEK_API_ORIGIN?: string
}

export type AppEnv = { Bindings: Bindings; Variables: { user: UserRow; sessionTokenHash: string } }
