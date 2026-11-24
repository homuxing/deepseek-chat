/** ZIP 条目名。导出顺序固定：manifest → 全部会话 JSON → index → 全部原件。 */

export const MANIFEST_PATH = 'manifest.json'
export const USER_PATH = 'user.json'
export const INDEX_PATH = 'chat_session_index.json'

export const sessionPath = (sessionId: string) => `chat_sessions/${sessionId}.json`

/** 会话自己的原件目录，带结尾斜杠。 */
export const sessionFilesDir = (sessionId: string) => `chat_sessions/${sessionId}_files/`

/** 会话 JSON 条目对应的会话 ID；其他条目返回 null */
export const parseSessionPath = (path: string): string | null =>
  /^chat_sessions\/([^/]+)\.json$/.exec(path)?.[1] ?? null

/** 安全路径片段：路径分隔符映射为 _，空值、. 与 .. 映射为 unnamed */
const safeName = (name: string) => {
  const result = name.replace(/[/\\]/g, '_')
  return result === '' || result === '.' || result === '..' ? 'unnamed' : result
}

/** 原件条目名；文件 ID 与文件名中的路径分隔符会转成下划线。 */
export const filePath = (sessionId: string, fileId: string, fileName: string) =>
  `${sessionFilesDir(sessionId)}${safeName(fileId)}_${safeName(fileName)}`.normalize('NFC')

/** 兼容已有调用；原件路径同样适用于图片与文档。 */
export const imagePath = filePath

export type OriginalPath = {
  sessionId: string
  fileId: string
  fileName: string
}

/**
 * 从原件条目名还原会话、文件 ID 与文件名。
 * 文件 ID 是条目 basename 中第一个下划线前的部分，后续下划线都属于文件名。
 */
export const parseOriginalPath = (path: string): OriginalPath | null => {
  const match = /^chat_sessions\/([^/]+)_files\/([^/_]+)_(.+)$/.exec(path)
  if (!match) {
    return null
  }
  const [, sessionId, fileId, fileName] = match
  return { sessionId, fileId, fileName }
}
