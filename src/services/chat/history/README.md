# 历史导入导出

Deepseek Chat 使用 `export_format_version: 3` 的历史会话 ZIP，导出文件名为 `deepseek_data-日期.zip`。字段定义见 [format.ts](./format.ts)，实际校验规则见 [schema.ts](./schema.ts)。

## 归档结构

导出按以下顺序写入：

```text
manifest.json                                      格式版本，必须是首个条目
chat_sessions/{session_id}.json                    全部会话 JSON（含消息树）
chat_session_index.json                            会话索引
chat_sessions/{session_id}_files/{file_id}_{file_name}  图片、文档等附件原件
```

导入要求 `manifest.json` 是首个文件条目，其后的会话 JSON、索引、原件和可选的 `user.json` 可按任意合法顺序排列。原件可以先于会话，索引可以前置或位于末尾。`user.json` 只检查 ZIP 完整性后跳过；本项目不导出账号信息。所有附件原件均按 `FILE.export_path` 匹配。

可选字段允许缺省，`pinned` 缺省为 `false`；时间接受以 `Z` 结尾、带可选小数秒的 UTC 时间。字段校验保留已定义的数据；未知片段类型、无法解析的正文、损坏容器及不合法元数据均导致导入失败。

同一文件 ID 可以由多个会话引用，在各自的会话目录使用不同 `export_path`。同一会话内同 ID 必须对应同一路径。多个目录中的原件副本必须字节一致，导入以分块内容指纹验证后仅保存一次；重复 ZIP 路径、重复会话或消息 ID、冲突文件映射及未被引用的原件都会导致失败。

## 导入与替换

1. 用户确认覆盖后，导入期间停止生成并禁止修改会话。浏览器读取 ZIP 目录，统计对话数和按文件 ID 去重后的附件数，再逐条解压、校验和转换；导入绑定当前账号和唯一任务 ID，ZIP 本身不上传给后端。
2. 小会话按最多 16 个且不超过 256 KiB 组成一批，通过 `POST /api/chats/imports/:id/chats` 写入；不超过 8 MiB 的附件使用直接 `PUT`，超过该大小的对象继续使用 multipart upload。会话批次与附件共用最多四个并发任务。共享原件首次读取后上传，后续副本仍进行大小、CRC 和完整内容指纹校验，全部校验通过后才能提交；同一旧 ID 的所有引用共用新 ID，支持原件先于会话。总量来自 ZIP 目录，已完成计数只在对象存储成功后增加，由阻断操作的进度蒙层展示。
3. 会话与附件在独立导入版本中暂存。全部索引、消息树、附件映射和条目完整性校验完成后，D1 事务同时发布附件并切换历史目录。失败时停止新增任务，等待在途上传结束后清理本次暂存内容；成功后用响应中的完整目录自动更新界面。其他设备更新或登录失效会使提交失败，保留现有历史。结果响应丢失时确认已提交任务的结果，不重复上传。ZIP 解析在浏览器内完成，导入流程不依赖高额 `cpu_ms` 配置。实际容量仍受浏览器、Worker 和 Cloudflare 平台限制约束。

消息树以 `id` / `parent_id` 还原，父消息 ID 必须小于子消息 ID、角色交替、根为提问。`current_message_id` 决定当前分支；其他节点默认选中 ID 最大的子消息。缺失原件的附件保留文件名和大小，不进入后续请求；有原件的导入图片在首次用于请求时上传。

导入时逐会话转换为正式消息，正文、思考用时、模板标识、工具结果与阅读链接签名保存在完整会话 JSON 中，不保留原始归档消息副本。展示、请求与导出统一读取正式消息。D1 保存会话目录、标题、时间、置顶、版本及附件引用；R2 保存完整会话 JSON 和所有可取得的附件原件，正文大小不受 D1 单行存储限制。

原件 MIME 根据字节签名和文件名识别，记录在上传 metadata 中，并作为文件响应的 `Content-Type` 返回。会话附件保留 `isImage`，JSON 中 `mimeType` 可为空；图片预览使用原件响应 Blob，无需逐会话加载回填 MIME。缺失原件保留附件 ID、文件名、大小和类别，不伪造可用原件。

同一账号的设备通过 Durable Object `HistorySync` 的 WebSocket 接收变更通知，并自动读取最新目录与已打开会话。进入页面、操作完成、重新连接和页面恢复可见时自动同步，不使用固定轮询或手动刷新操作。通知仅携带状态，完整内容通过已鉴权接口读取。

`shared/history/importArchive.ts` 提供不依赖浏览器状态的归档校验、转换与有界并发处理。`server/cloudStorage.ts` 提供会话批量写入、附件上传和提交事务。`src/services/chat/history/` 负责浏览器内解压和归档转换，导入上传、结果确认与进度展示由 `src/services/chat/` 中的导入服务完成。

## 云端部署

`migrations/0004_cloud_history.sql` 添加云端目录代次、会话版本、R2 正文引用、附件引用及导入和 multipart upload 状态表，并保留现有用户与会话。现有 D1 会话正文仍可读取，后续写入使用 R2。部署前应用该迁移：本地运行 `pnpm db:migrate:local`，生产部署使用 `pnpm deploy` 或 `pnpm deploy:worker`，两者均在 Worker 发布前执行 `pnpm db:migrate:remote`。

`migrations/0007_archive_import.sql` 添加的 `archive_mode` 字段与暂存附件记录保留兼容旧整包路径，新导入路径依赖 `migrations/0004_cloud_history.sql` 建立的目录、会话版本、附件及上传表。应应用全部迁移，避免环境之间出现表结构差异。

`wrangler.jsonc` 需要 D1 `DB`、私有 R2 `FILES` 和 Durable Object `SYNC` 绑定。`SYNC` 指向 Worker 导出的 `HistorySync` 类，Durable Object 迁移使用 `history-sync-v1` 和 `new_sqlite_classes: ["HistorySync"]`。Wrangler 发布 Worker 时同时应用该 DO 迁移；D1 迁移和 DO 绑定均需完成，多设备通知依赖这份部署配置。

## 展示与上下文

- 展示提问、正文、思考、附件，以及搜索、打开网页、页内查找步骤。搜索状态和查找词存在时用于展示；`READ_LINK` 有合法 URL 时展示链接与标题，仅含签名的记录用于请求上下文。展示链接仅接受 HTTP / HTTPS。
- `TIP`、`CONTENT_RISK`、`PARTIAL_FILE_READ`、`TOOL_IMAGE_SEARCH` 等没有对应展示的内容直接丢弃，不显示占位或提示；工具分组等未映射到本地消息的元数据也不保留。完整转换规则见 [toLocal.ts](./toLocal.ts)。
- `FINISHED` 转成已完成，`INCOMPLETE` / `WIP` 转成已停止，`FAILED` / `CONTEXT_LENGTH_EXCEEDED` / `TIMEOUT` 转成错误，`CONTENT_FILTER` 转成拒绝。思考与搜索开关保存在回复中。
- 错误回复的模板文案显示为红字和感叹号提示，正文和思考独立展示。拒绝及其他非错误模板使用正文样式，拒绝回复丢弃普通正文和思考，可复制模板，不能重新生成。模板统一单独展示，不混入工具步骤前的说明文字。
- 错误与模板回复保留在消息树中，其所在轮次不进入后续请求上下文。
- 已完成或已停止、有正文、非拒绝且不含服务端模板的回复可以进入上下文。
- 续写统一由本地消息的 `prefix` 与回复状态、内容决定：新生成的回复设置 `prefix: true`，导入的回复统一设置 `prefix: false`，不能继续生成。模板回复与含工具块的回复也不能续写。`prefix` 不发送到 API；只有允许续写的回复才会作为末尾 assistant 发送。
- 请求从当前消息回传正文及 `READ_LINK` 工具块中的签名、URL 和标题，供服务端恢复网页上下文。历史思考和其他工具块不回传，见 [../reply.ts](../reply.ts)。

## 导出范围

导出完整消息树、当前分支和置顶属性，附带可取得的图片、文档及其他附件原件。共享文件 ID 只读取一次，每个引用它的会话目录使用同一原件快照；同一会话内的重复引用使用同一路径。缺失原件只保留元数据，`export_path` 为 `null`。所有消息都从当前正式消息转换为归档片段，包含搜索状态、页内查找词、模板正文、思考用时，以及成功阅读链接结果的签名、URL 和标题。具体映射见 [toArchive.ts](./toArchive.ts)。

本地错误和拒绝提示以导出时的界面语言写入 `TEMPLATE_RESPONSE`，导入后保留文案且不参与上下文；正常空回复和达到长度上限的回复不补造提示。已有模板原样保留，重复导出不会重复追加这些提示。

导出开始时保留列表和已加载会话的内存快照，未打开的会话再逐条从服务端读取，不写入界面详情缓存。`exportArchive(sessions, loadOriginal?)` 支持原件读取回调，默认使用 `db.loadFile`；正式入口通过回调在读取前后检查账号身份。读取失败或账号变更导致整次导出失败，缺失原件与读取失败分别处理；导出标题采用开始时的列表快照。

归档不保存 API Key 或应用设置，也不能完整恢复本地运行状态：正文引用角标、模型、思考签名、原工具调用 ID、结构化错误信息（类型、状态码及重试操作等）、用量明细、非当前分支的选择，以及 `latestReminder` 快照不会保留。新提问的快照按当前设置生成。

## 模块与 ZIP 支持

| 文件                                                                           | 职责                                 |
| ------------------------------------------------------------------------------ | ------------------------------------ |
| [format.ts](./format.ts)、[schema.ts](./schema.ts)                             | 归档类型与字段校验                   |
| [toLocal.ts](./toLocal.ts)、[toArchive.ts](./toArchive.ts)                     | 归档与本地消息转换                   |
| [importArchive.ts](./importArchive.ts)、[exportArchive.ts](./exportArchive.ts) | 归档测试入口、共享原件校验与导出组装 |
| [zipReader.ts](./zipReader.ts)、[zipWriter.ts](./zipWriter.ts)                 | ZIP 读写及路径、大小、CRC 校验       |
| [../backup.ts](../backup.ts)                                                   | 导入导出入口与串行队列               |

支持单卷 ZIP32 和 ZIP64 的 STORE / DEFLATE，导出使用 STORE。读取支持 ZIP64 目录、64 位大小与偏移和 64 位 data descriptor；写入在条目数量、大小或偏移达到 ZIP32 边界时自动使用 ZIP64。加密、分卷及非 UTF-8 的非 ASCII 文件名不支持；条目名统一按 NFC 比较，并校验路径、大小和 CRC。不另设业务大小上限，文件大小仍须处于 JavaScript 安全整数范围，导出会生成完整下载 Blob，实际受浏览器资源约束。
