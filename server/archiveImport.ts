import type { AppEnv } from './types.js'

export const archiveImportPrefix = (userId: string, importId: string) =>
  `${userId}/imports/${importId}/`
/** 清理仅限本次导入前缀，已提交的附件与会话保留。 */
export const cleanupArchiveImport = async (
  env: AppEnv['Bindings'],
  userId: string,
  importId: string
): Promise<void> => {
  const row = await env.DB.prepare('SELECT status FROM cloud_imports WHERE user_id = ? AND id = ?')
    .bind(userId, importId)
    .first<{ status: string }>()
  if (row?.status === 'committed') {
    return
  }
  const prefix = archiveImportPrefix(userId, importId)
  let cursor: string | undefined
  do {
    const listed = await env.FILES.list({ prefix, limit: 500 })
    if (listed.objects.length) {
      await env.FILES.delete(listed.objects.map((object) => object.key))
    }
    // 删除后从前缀起点继续读取，避免基于位置的 cursor 跳过剩余对象。
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM chats WHERE user_id = ? AND generation = (SELECT generation FROM cloud_imports WHERE user_id = ? AND id = ? AND status = 'cancelled')"
    ).bind(userId, userId, importId),
    env.DB.prepare('DELETE FROM cloud_archive_files WHERE user_id = ? AND import_id = ?').bind(
      userId,
      importId
    ),
  ])
}
