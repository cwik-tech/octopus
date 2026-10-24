import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'

const mutationTails = new Map<string, Promise<void>>()

/** Serialize read-modify-write mutations for one path inside this runtime. */
export async function withFileMutationLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath)
  const previous = mutationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  mutationTails.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (mutationTails.get(key) === current) mutationTails.delete(key)
  }
}

export async function writeFileAtomic(
  filePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, filePath)
    const directoryHandle = await fs.open(directory, 'r').catch(() => null)
    if (directoryHandle) {
      try {
        await directoryHandle.sync().catch(() => undefined)
      } finally {
        await directoryHandle.close().catch(() => undefined)
      }
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

/** Synchronous counterpart for runtime persistence paths that are sync today. */
export function writeFileAtomicSync(
  filePath: string,
  contents: string | Uint8Array,
): void {
  const directory = path.dirname(filePath)
  fsSync.mkdirSync(directory, { recursive: true })
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let descriptor: number | undefined
  try {
    descriptor = fsSync.openSync(temporaryPath, 'wx', 0o600)
    fsSync.writeFileSync(descriptor, contents)
    fsSync.fsyncSync(descriptor)
    fsSync.closeSync(descriptor)
    descriptor = undefined
    fsSync.renameSync(temporaryPath, filePath)
    let directoryDescriptor: number | undefined
    try {
      directoryDescriptor = fsSync.openSync(directory, 'r')
      fsSync.fsyncSync(directoryDescriptor)
    } catch {
      // Some platforms/filesystems do not support syncing directory handles.
    } finally {
      if (directoryDescriptor !== undefined) {
        fsSync.closeSync(directoryDescriptor)
      }
    }
  } finally {
    if (descriptor !== undefined) fsSync.closeSync(descriptor)
    fsSync.rmSync(temporaryPath, { force: true })
  }
}

export function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}
