const messages = {
  backupInvalidJson: '文件不是有效的 JSON',
  backupUnrecognized: '无法识别该文件，请选择 DeepSeek 导出的历史对话 ZIP 文件',
  backupNewerVersion: '文件版本过新，请升级后再导入',
  backupInvalidVersion: '文件版本无效，无法导入',
  backupIncomplete: '文件内容不完整，无法导入',
  backupSourceUnavailable: '无法继续读取选中的 ZIP 文件，请确认文件已完整下载且仍保存在本机。',
  backupStorageUnavailable: '当前浏览器无法保存导入文件，请使用支持文件存储的浏览器。',
  backupStorageFull: '保存导入文件的空间不足，请释放本机空间后重新导入。',
  backupInvalidBranches: '文件中的消息分支已损坏，无法导入',
  backupInvalidFiles: '文件中的附件数据已损坏，无法导入',
} as const

export type BackupErrorKey = keyof typeof messages

/** 归档校验不依赖浏览器状态，前后端共享同一组错误及校验规则。 */
export class BackupError extends Error {
  constructor(readonly key: BackupErrorKey) {
    super(messages[key])
    this.name = 'BackupError'
  }
}

export const fail = (key: BackupErrorKey): never => {
  throw new BackupError(key)
}

export const sourceReadError = (error: unknown): unknown => {
  if (
    error instanceof DOMException &&
    ['NotFoundError', 'NotReadableError', 'SecurityError'].includes(error.name)
  ) {
    const failure = new BackupError('backupSourceUnavailable')
    failure.cause = error
    return failure
  }
  return error
}
