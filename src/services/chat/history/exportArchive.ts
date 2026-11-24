import * as db from '../db.js'
import type { Session } from '../types.js'
import { EXPORT_FORMAT_VERSION, type Manifest, type SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, filePath, sessionPath } from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/**
 * 按导出格式生成 ZIP：manifest → 全部会话 JSON → index → 全部原件。
 * 每个会话目录各写一份；本地缺失原件的附件只保留元数据。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  loadOriginal: (id: string) => Promise<Blob | undefined> = db.loadFile
): Promise<Blob> => {
  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  const originalEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  for await (const session of sessions) {
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (!originals.has(file.id)) {
            // 同一 ID 只读取一次，所有会话目录使用同一原件快照。
            originals.set(file.id, await loadOriginal(file.id))
          }
        }
      }
    }
    const sessionOriginals = new Map<string, Blob>()
    const originalPaths = new Map<string, string>()
    const data = toSessionFile(session, ({ id, name }) => {
      const blob = originals.get(id)
      if (!blob) {
        return null
      }
      const existing = originalPaths.get(id)
      if (existing) {
        return existing
      }
      const path = filePath(session.id, id, name)
      originalPaths.set(id, path)
      sessionOriginals.set(path, blob)
      return path
    })
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    for (const [name, blob] of sessionOriginals) {
      originalEntries.push({ name, blob })
    }
    index.push(toIndexEntry(data))
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  return writeArchive(entries.concat(originalEntries))
}
