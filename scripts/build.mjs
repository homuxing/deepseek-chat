import { spawnSync } from 'node:child_process'

const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(executable, ['exec', 'rspack', 'build', '-c', 'rspack.config.ts'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
