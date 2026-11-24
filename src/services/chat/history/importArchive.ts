import * as db from '../db.js'
import {
  importArchive as readImportArchive,
  type ArchiveImportSink,
  type ArchiveImportOptions,
} from '../../../../shared/history/importArchive.js'

export { checkArchiveFormat } from '../../../../shared/history/importArchive.js'
export type {
  ArchiveImportSink,
  ArchiveImportOptions,
} from '../../../../shared/history/importArchive.js'

/** 内存暂存入口用于归档测试；实际导入由后端执行。 */
export const importArchive = (
  file: File,
  sink: ArchiveImportSink = {
    addSession: db.addStagingSession,
    saveFiles: db.saveStagingFiles,
    updateFileTypes: db.updateStagingFileTypes,
  },
  options?: ArchiveImportOptions
): Promise<void> => readImportArchive(file, sink, options)
