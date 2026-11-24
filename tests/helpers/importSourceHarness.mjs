/** 模拟 OPFS 的写入完成后快照与删除语义，测试无需读取用户文件。 */
export const installImportStorage = () => {
  const files = new Map()
  const previous = Object.getOwnPropertyDescriptor(navigator, 'storage')
  const state = { files, beforeWrite: undefined }
  const directory = {
    async getDirectoryHandle() {
      return directory
    },
    async getFileHandle(name) {
      files.set(name, new Blob())
      return {
        async createWritable() {
          const parts = []
          return new WritableStream({
            async write(chunk) {
              await state.beforeWrite?.(chunk)
              parts.push(new Uint8Array(chunk))
            },
            close() {
              files.set(name, new Blob(parts))
            },
            abort() {
              files.delete(name)
            },
          })
        },
        async getFile() {
          return new File([files.get(name)], name)
        },
      }
    },
    async removeEntry(name) {
      files.delete(name)
    },
  }
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => directory },
  })
  return {
    ...state,
    state,
    dispose() {
      if (previous) Object.defineProperty(navigator, 'storage', previous)
      else delete navigator.storage
    },
  }
}
