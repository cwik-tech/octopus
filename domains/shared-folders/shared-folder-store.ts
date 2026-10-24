import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { isValidWorkspaceProjectId } from '../../contracts/projects.js'
import { isValidSessionId } from '../../contracts/sessions.js'
import {
  SHARED_FOLDERS_PER_OWNER_LIMIT,
  sharedFolderListFileSchema,
  type SharedFolderRecord,
} from '../../contracts/shared-folders.js'
import { writeFileAtomic } from '../../core/file-mutation.js'

/**
 * The folder lists that chats and projects own
 * (docs/feature-local-folder-access.md, "Where folder lists live").
 *
 * A chat's list sits beside its `session.json`, and a project's beside its
 * brief in `context/`, so deleting the chat or the project removes it. Paths
 * arrive already admitted by the access policy; this store only keeps the
 * list, its limit, and its identities.
 */

export type SharedFolderOwner =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'project'; readonly projectId: string }

export type SharedFolderAddResult =
  | { readonly kind: 'added'; readonly record: SharedFolderRecord }
  | { readonly kind: 'duplicate'; readonly record: SharedFolderRecord }
  | { readonly kind: 'limit' }

/**
 * The app names chats with lowercase UUIDs. Another letter case names the same
 * folder on a case-insensitive disk but a different chat everywhere else, so it
 * is refused rather than allowed to skip the chat's project rules.
 */
export function isCanonicalSessionId(value: string): boolean {
  return isValidSessionId(value) && value === value.toLowerCase()
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export class SharedFolderStore {
  /** Writes to one list run one at a time, so concurrent adds are all kept. */
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly workspacePath: string) {}

  async list(owner: SharedFolderOwner): Promise<SharedFolderRecord[]> {
    return this.read(this.listPath(owner))
  }

  async add(
    owner: SharedFolderOwner,
    input: { readonly canonicalPath: string; readonly label: string },
  ): Promise<SharedFolderAddResult> {
    const filePath = this.listPath(owner)
    return this.serialize(filePath, async () => {
      const folders = await this.read(filePath)
      const existing = folders.find((folder) => folder.path === input.canonicalPath)
      if (existing) return { kind: 'duplicate', record: existing }
      if (folders.length >= SHARED_FOLDERS_PER_OWNER_LIMIT) return { kind: 'limit' }
      const record: SharedFolderRecord = {
        version: 1,
        id: newFolderId(new Set(folders.map((folder) => folder.id))),
        path: input.canonicalPath,
        label: input.label.slice(0, 255) || 'Folder',
        access: 'read',
        addedAt: new Date().toISOString(),
      }
      await this.write(filePath, [...folders, record])
      return { kind: 'added', record }
    })
  }

  /**
   * Every folder some chat or project still lists, read from disk each time,
   * so a chat or project deleted a moment ago no longer holds its folders. A
   * list that can't be read attaches nothing: no turn can use it either.
   */
  async attachedPaths(): Promise<ReadonlySet<string>> {
    const lists = [
      ...(await childNames(path.join(this.workspacePath, 'sessions')))
        .filter(isCanonicalSessionId)
        .map((sessionId) => this.listPath({ kind: 'session', sessionId })),
      ...(await childNames(path.join(this.workspacePath, 'projects')))
        .filter(isValidWorkspaceProjectId)
        .map((projectId) => this.listPath({ kind: 'project', projectId })),
    ]
    const paths = new Set<string>()
    for (const list of lists) {
      for (const folder of await this.read(list).catch(() => [])) paths.add(folder.path)
    }
    return paths
  }

  async remove(owner: SharedFolderOwner, id: string): Promise<boolean> {
    const filePath = this.listPath(owner)
    return this.serialize(filePath, async () => {
      const folders = await this.read(filePath)
      const remaining = folders.filter((folder) => folder.id !== id)
      if (remaining.length === folders.length) return false
      await this.write(filePath, remaining)
      return true
    })
  }

  private listPath(owner: SharedFolderOwner): string {
    if (owner.kind === 'project') {
      if (!isValidWorkspaceProjectId(owner.projectId)) {
        throw new Error('Shared folders need a valid project id.')
      }
      return path.join(this.workspacePath, 'projects', owner.projectId, 'context', 'folders.json')
    }
    if (!isCanonicalSessionId(owner.sessionId)) {
      throw new Error('Shared folders need a valid session id.')
    }
    return path.join(this.workspacePath, 'sessions', owner.sessionId, 'folders.json')
  }

  private async read(filePath: string): Promise<SharedFolderRecord[]> {
    const raw = await fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return []
    const parsed = sharedFolderListFileSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(`Shared folder list is invalid: ${filePath}`)
    }
    return parsed.data.folders
  }

  private async write(filePath: string, folders: readonly SharedFolderRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await writeFileAtomic(filePath, `${JSON.stringify({ version: 1, folders }, null, 2)}\n`)
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const running = previous.then(operation)
    const tail = running.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return running
  }
}

async function childNames(directory: string): Promise<string[]> {
  return fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}

function newFolderId(taken: ReadonlySet<string>): string {
  for (;;) {
    const bytes = randomBytes(10)
    const id = `f_${Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`
    if (!taken.has(id)) return id
  }
}
