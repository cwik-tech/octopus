import * as path from 'node:path'

import type { WorkspaceProject } from '../contracts/projects.js'
import type { SharedFolderRecord, SharedFolderStatus, SharedFolderView } from '../contracts/shared-folders.js'
import type { FileParserLauncher } from '../core/file-parser-launcher.js'
import {
  WorkspaceProjectServiceError,
  type WorkspaceProjectService,
} from '../domains/projects/workspace-project-service.js'
import { folderRootState, walkFolder, type FolderWalk } from '../domains/shared-folders/folder-access.js'
import { folderIndexDocuments, type FolderDocumentIndex } from '../domains/shared-folders/folder-documents.js'
import { FolderIndex, type FolderIndexOptions } from '../domains/shared-folders/folder-index.js'
import type { SharedFolderAccessPolicy } from '../domains/shared-folders/shared-folder-access-policy.js'
import type { SharedFolderOwner, SharedFolderStore } from '../domains/shared-folders/shared-folder-store.js'
import type { FolderToolPolicy, TurnFolder } from './folder-tool-adapters.js'

/**
 * Attaching local folders and resolving a turn's folders
 * (docs/feature-local-folder-access.md).
 *
 * Every path is admitted by the access policy before it is stored, and a
 * turn's folders are worked out here, on the server, from what is stored. The
 * client never sends a folder selection with a turn.
 *
 * A chat sees its project's folders first, then its own, with a folder both
 * share listed once, as the project's. Membership is read when asked, so a chat
 * moved into or out of a project gains or loses the project's folders on its
 * next list or turn, and its own folders stay its own.
 *
 * With a file parser, documents in attached folders are parsed, local-only,
 * into the workspace's folder index ("Indexing and the parse cache"). Attaching
 * a folder starts its indexing in the background; each turn's folder map is
 * the freshness check; a folder that loses its last attachment or its grant
 * loses its parses and its parsed text, whether the attachment goes with a
 * detach or with its chat or project. Every listed folder carries a status
 * worked out from its grant, a check of the folder itself and the index.
 */

export type AttachSharedFolderResult =
  | { readonly kind: 'attached'; readonly folder: SharedFolderView }
  | { readonly kind: 'duplicate'; readonly folder: SharedFolderView }
  | { readonly kind: 'limit'; readonly message: string }
  | { readonly kind: 'already_in_project'; readonly message: string }
  | {
      readonly kind: 'refused'
      readonly code: 'not_a_folder' | 'not_granted' | 'protected_overlap'
      readonly message: string
    }

/** How the service finds a chat's project and a project's name and status. */
export type SharedFolderProjects = Pick<WorkspaceProjectService, 'getSession' | 'getProjectRecord'>

/** The document cache's settings; the service decides what keeps a folder's cache. */
export type SharedFolderIndexOptions = Omit<FolderIndexOptions, 'isRetained'>

/**
 * The parser, stopped as a whole when the service closes. A parse stopped this
 * way is never recorded as a failure: while the service is closing no folder
 * counts as retained, so the index discards the run and the document stays
 * pending for the next start.
 */
function stoppableLauncher(launcher: FileParserLauncher, stop: AbortSignal): FileParserLauncher {
  return {
    parseDirectory: (inputDir, options) => launcher.parseDirectory(inputDir, options),
    parseFile: (input, options = {}) => launcher.parseFile(input, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, stop]) : stop,
    }),
  }
}

function sessionView(record: SharedFolderRecord): SharedFolderView {
  return { id: record.id, label: record.label, path: record.path, source: 'session', addedAt: record.addedAt }
}

function projectView(record: SharedFolderRecord, project: WorkspaceProject): SharedFolderView {
  return {
    id: record.id,
    label: record.label,
    path: record.path,
    source: 'project',
    addedAt: record.addedAt,
    projectId: project.id,
    projectName: project.name,
  }
}

export class SharedFolderService {
  readonly toolPolicy: FolderToolPolicy
  private readonly index: FolderIndex | undefined
  private readonly documents: FolderDocumentIndex | undefined
  private readonly shutdown = new AbortController()
  /** Indexing walks still running, so `whenIdle` and `close` can wait for them. */
  private readonly background = new Set<Promise<void>>()
  /** Roots whose indexing walk is running, with how many walks. */
  private readonly scanning = new Map<string, number>()
  /** What each folder's last walk found, for its status; kept in memory only. */
  private readonly lastScans = new Map<string, { readonly files: number; readonly limited: boolean }>()
  /**
   * Retention work, one step at a time. Lists and turns wait for it, so none
   * sees a folder whose cache is half deleted.
   */
  private retention: Promise<void> = Promise.resolve()

  constructor(private readonly options: {
    readonly store: SharedFolderStore
    readonly policy: SharedFolderAccessPolicy
    readonly projects: SharedFolderProjects
    /** The document cache. Without it, documents in folders are files that can't be read. */
    readonly index?: SharedFolderIndexOptions | undefined
  }) {
    this.index = options.index
      ? new FolderIndex({
          ...options.index,
          launcher: stoppableLauncher(options.index.launcher, this.shutdown.signal),
          isRetained: (root) => this.isRetained(root),
        })
      : undefined
    this.documents = this.index ? this.recordingScans(folderIndexDocuments(this.index)) : undefined
    this.toolPolicy = {
      isRootGranted: (root) => options.policy.isRootGranted(root),
      isProtected: (absolutePath) => options.policy.isProtected(absolutePath),
      documents: this.documents,
    }
  }

  /**
   * Once, before the server takes requests: the document cache drops what a
   * crash left unfinished and the cache of every folder no longer kept.
   */
  async start(): Promise<void> {
    if (!this.index) return
    await this.index.startup()
    const attached = [...await this.options.store.attachedPaths()]
    // Documents a restart interrupted are parsed again without waiting for a
    // turn, one folder at a time so a start never walks every folder at once.
    this.track((async () => {
      for (const root of attached) {
        if (await this.options.policy.isRootGranted(root)) await this.indexFolder(root)
      }
    })())
  }

  /**
   * The grant list changed (SEC-9). Tool calls already read the grant on
   * every call; this stops the parses of every folder whose grant is gone,
   * background or asked for by a read, and deletes its parsed text.
   */
  handleGrantsChanged(): void {
    void this.releaseAllUnkept()
  }

  /**
   * A chat or project was deleted, and its folder list with it. Resolves once
   * every folder nothing attaches any more has lost its parses and parsed text.
   */
  handleOwnerDeleted(): Promise<void> {
    return this.releaseAllUnkept()
  }

  /** Resolves once no indexing, retention or parse work is left. */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background])
    await this.retention
    await this.index?.whenIdle()
  }

  /** Stop every walk and parse and wait until none is running; nothing they leave behind is published. */
  async close(): Promise<void> {
    this.shutdown.abort()
    await this.whenIdle()
  }

  /**
   * Whether a folder's parsed text may be kept and published: its grant still
   * exists, and some chat or project still attaches it.
   */
  async isRetained(root: string): Promise<boolean> {
    if (this.shutdown.signal.aborted) return false
    return this.isKept(root)
  }

  /** Granted, and attached to some chat or project, whether or not the service is closing. */
  private async isKept(root: string): Promise<boolean> {
    if (!await this.options.policy.isRootGranted(root)) return false
    return (await this.options.store.attachedPaths()).has(root)
  }

  /** The chat's project folders first, then its own folders the project does not share, each with its status. */
  async listForSession(sessionId: string): Promise<SharedFolderView[]> {
    return this.withStatus(await this.foldersOfSession(sessionId))
  }

  private async foldersOfSession(sessionId: string): Promise<SharedFolderView[]> {
    await this.retention
    const [project, own] = await Promise.all([
      this.projectOfSession(sessionId),
      this.options.store.list({ kind: 'session', sessionId }),
    ])
    const fromProject = project ? await this.projectFolders(project) : []
    const sharedPaths = new Set(fromProject.map((folder) => folder.path))
    return [
      ...fromProject,
      ...own.filter((record) => !sharedPaths.has(record.path)).map(sessionView),
    ]
  }

  async attachToSession(sessionId: string, requestedPath: string): Promise<AttachSharedFolderResult> {
    const admitted = await this.options.policy.admitRoot(requestedPath)
    if (!admitted.ok) return { kind: 'refused', code: admitted.code, message: admitted.message }
    const project = await this.projectOfSession(sessionId)
    if (project) {
      const fromProject = await this.options.store.list({ kind: 'project', projectId: project.id })
      if (fromProject.some((folder) => folder.path === admitted.canonicalPath)) {
        return {
          kind: 'already_in_project',
          message: `This folder is already shared with the project "${project.name}".`,
        }
      }
    }
    const added = await this.options.store.add(
      { kind: 'session', sessionId },
      { canonicalPath: admitted.canonicalPath, label: path.basename(admitted.canonicalPath) },
    )
    if (added.kind === 'limit') {
      return { kind: 'limit', message: 'A chat can have up to 10 of its own folders.' }
    }
    this.startIndexing(added.record.path)
    return { kind: added.kind === 'added' ? 'attached' : 'duplicate', folder: sessionView(added.record) }
  }

  /** Once the chat's folder is removed, a folder nothing else attaches loses its parses and parsed text. */
  async detachFromSession(sessionId: string, folderId: string): Promise<boolean> {
    return this.detach({ kind: 'session', sessionId }, folderId)
  }

  /** Throws `project_not_found` for an unknown project. */
  async listForProject(projectId: string): Promise<SharedFolderView[]> {
    await this.retention
    return this.withStatus(await this.projectFolders(await this.options.projects.getProjectRecord(projectId)))
  }

  /** Throws `project_not_found`, or `archived_project` because archived projects are read-only. */
  async attachToProject(projectId: string, requestedPath: string): Promise<AttachSharedFolderResult> {
    const project = await this.activeProject(projectId)
    const admitted = await this.options.policy.admitRoot(requestedPath)
    if (!admitted.ok) return { kind: 'refused', code: admitted.code, message: admitted.message }
    const added = await this.options.store.add(
      { kind: 'project', projectId: project.id },
      { canonicalPath: admitted.canonicalPath, label: path.basename(admitted.canonicalPath) },
    )
    if (added.kind === 'limit') {
      return { kind: 'limit', message: 'A project can have up to 10 folders.' }
    }
    this.startIndexing(added.record.path)
    return {
      kind: added.kind === 'added' ? 'attached' : 'duplicate',
      folder: projectView(added.record, project),
    }
  }

  /** Throws `project_not_found`, or `archived_project` because archived projects are read-only. */
  async detachFromProject(projectId: string, folderId: string): Promise<boolean> {
    const project = await this.activeProject(projectId)
    return this.detach({ kind: 'project', projectId: project.id }, folderId)
  }

  /**
   * The folders one turn may touch, resolved once when it starts: the same
   * list, in the same order, that the chat shows.
   */
  async resolveTurnFolders(sessionId: string): Promise<TurnFolder[]> {
    return (await this.foldersOfSession(sessionId)).map((folder) => ({
      id: folder.id,
      label: folder.label,
      root: folder.path,
      source: folder.source,
    }))
  }

  private async detach(owner: SharedFolderOwner, folderId: string): Promise<boolean> {
    const record = (await this.options.store.list(owner)).find((folder) => folder.id === folderId)
    const removed = await this.options.store.remove(owner, folderId)
    if (removed && record) await this.releaseIfUnkept(record.path)
    return removed
  }

  /**
   * Retention ("Scheduling and publishing"): a folder no chat or project
   * attaches any more, or whose grant is gone, has its queued parses dropped,
   * its running ones stopped, and its cache folder deleted.
   */
  private releaseIfUnkept(root: string): Promise<void> {
    this.retention = this.retention.then(async () => {
      if (!await this.isRetained(root)) await this.drop(root)
    }).catch((error: unknown) => {
      // The folder is detached either way; its cache goes at the next start.
      console.error('Releasing a shared folder failed.', error)
    })
    return this.retention
  }

  /**
   * Retention for every folder the index has opened, which covers every
   * folder with parses or parsed text however they began: an indexing walk,
   * a turn's freshness check or a read. Asks whether each folder is kept, not
   * retained, so a call while the service closes deletes no folder's cache
   * that is still attached.
   */
  private releaseAllUnkept(): Promise<void> {
    const index = this.index
    if (!index) return Promise.resolve()
    this.retention = this.retention.then(async () => {
      for (const root of await index.openedRoots()) {
        if (!await this.isKept(root)) await this.drop(root)
      }
    }).catch((error: unknown) => {
      // Whatever was not released here goes at the next start.
      console.error('Releasing shared folders failed.', error)
    })
    return this.retention
  }

  private async drop(root: string): Promise<void> {
    this.lastScans.delete(root)
    await this.index?.dropFolder(root)
  }

  private async withStatus(folders: readonly SharedFolderView[]): Promise<SharedFolderView[]> {
    return Promise.all(folders.map(async (folder) => ({ ...folder, status: await this.statusOf(folder.path) })))
  }

  /**
   * A folder's status ("Status" in the feature document), from its grant, a
   * check of the folder itself, and what the index and the last walk know.
   * Never a walk of its own: a list is read often.
   */
  private async statusOf(root: string): Promise<SharedFolderStatus> {
    if (!await this.options.policy.isRootGranted(root)) return { state: 'unavailable', reason: 'access_removed' }
    const located = await folderRootState(root)
    if (located !== 'available') return { state: 'unavailable', reason: located }
    const scan = this.lastScans.get(root)
    const files = scan ? { files: scan.files } : {}
    const indexed = await this.index?.status(root).catch((error: unknown) => {
      console.error('Reading a shared folder index failed.', error)
      return undefined
    }) ?? { pendingDocuments: 0 }
    const limits = [
      ...(scan?.limited ? [`Only the first ${scan.files.toLocaleString('en-US')} files are indexed.`] : []),
      ...(indexed.limit ? [indexed.limit] : []),
    ]
    const limit = limits.length > 0 ? { limit: limits.join(' ') } : {}
    if (this.scanning.has(root) || indexed.pendingDocuments > 0) {
      const pending = indexed.pendingDocuments > 0 ? { pendingDocuments: indexed.pendingDocuments } : {}
      return { state: 'indexing', ...files, ...pending, ...limit }
    }
    return limits.length > 0 ? { state: 'partial', ...files, ...limit } : { state: 'ready', ...files }
  }

  /** The index's freshness check, with what each walk found kept for the folder's status. */
  private recordingScans(documents: FolderDocumentIndex): FolderDocumentIndex {
    return {
      ...documents,
      refresh: async (root: string, walk: FolderWalk) => {
        // A walk the turn's map cut short for time says nothing about the folder's size.
        if (!walk.deadlineReached) this.lastScans.set(root, { files: walk.files.length, limited: walk.truncated })
        try {
          return await documents.refresh(root, walk)
        } catch (error) {
          console.error('Indexing a shared folder failed.', error)
          throw error
        }
      },
    }
  }

  /**
   * Walk a folder in the background and hand its documents to the index,
   * which parses them one queue at a time. The request that attached the
   * folder does not wait.
   */
  private startIndexing(root: string): void {
    this.track(this.indexFolder(root))
  }

  private async indexFolder(root: string): Promise<void> {
    const documents = this.documents
    if (!documents || this.shutdown.signal.aborted) return
    this.scanning.set(root, (this.scanning.get(root) ?? 0) + 1)
    try {
      const walk = await walkFolder(
        { root, isProtected: (absolutePath) => this.options.policy.isProtected(absolutePath), documents },
        { signal: this.shutdown.signal },
      )
      if (!walk.ok || !await this.isRetained(root)) return
      await documents.refresh(root, walk)
    } finally {
      const walks = (this.scanning.get(root) ?? 1) - 1
      if (walks > 0) this.scanning.set(root, walks)
      else this.scanning.delete(root)
    }
  }

  /** Background work `whenIdle` and `close` wait for; a failure is logged, never thrown at a caller. */
  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      console.error('Indexing a shared folder failed.', error)
    })
    this.background.add(tracked)
    void tracked.finally(() => this.background.delete(tracked))
  }

  private async projectFolders(project: WorkspaceProject): Promise<SharedFolderView[]> {
    const records = await this.options.store.list({ kind: 'project', projectId: project.id })
    return records.map((record) => projectView(record, project))
  }

  /** The chat's project, or null when it has none or the project has just been deleted. */
  private async projectOfSession(sessionId: string): Promise<WorkspaceProject | null> {
    const session = await this.options.projects.getSession(sessionId)
    if (!session?.projectId) return null
    try {
      return await this.options.projects.getProjectRecord(session.projectId)
    } catch (error) {
      if (error instanceof WorkspaceProjectServiceError && error.code === 'project_not_found') return null
      throw error
    }
  }

  private async activeProject(projectId: string): Promise<WorkspaceProject> {
    const project = await this.options.projects.getProjectRecord(projectId)
    if (project.status !== 'active') {
      throw new WorkspaceProjectServiceError('archived_project', 'Archived projects are read-only')
    }
    return project
  }
}
