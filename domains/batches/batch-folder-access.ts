import * as path from 'node:path'

import {
  isPathEqualOrInside,
  resolveCanonicalDirectory,
} from '../../core/path-safety.js'

export interface BatchFolderAccessPolicy {
  resolveAllowedFolder(folderPath: string): Promise<string | null>
}
export interface DefaultBatchFolderAccessPolicyOptions {
  readonly workspacePath: string
  readonly repoRootPath: string
  readonly listGrants?: () => Promise<readonly string[]>
}
export class DefaultBatchFolderAccessPolicy implements BatchFolderAccessPolicy {
  private readonly workspacePath: string
  private readonly repoRootPath: string
  private readonly listGrants: () => Promise<readonly string[]>

  constructor(options: DefaultBatchFolderAccessPolicyOptions) {
    this.workspacePath = path.resolve(options.workspacePath)
    this.repoRootPath = path.resolve(options.repoRootPath)
    this.listGrants = options.listGrants ?? (async () => [])
  }

  async resolveAllowedFolder(folderPath: string): Promise<string | null> {
    if (!path.isAbsolute(folderPath)) return null
    const canonicalFolder = await resolveCanonicalDirectory(folderPath)
    if (!canonicalFolder) return null
    const [workspaceRoot, repositoryRoot, grants] = await Promise.all([
      resolveCanonicalDirectory(this.workspacePath),
      resolveCanonicalDirectory(this.repoRootPath),
      this.listGrants(),
    ])
    const roots = [workspaceRoot, repositoryRoot, ...grants]
      .filter((root): root is string => typeof root === 'string')
    return roots.some((root) => isPathEqualOrInside(root, canonicalFolder))
      ? canonicalFolder
      : null
  }
}
