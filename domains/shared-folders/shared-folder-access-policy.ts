import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  isPathEqualOrInside,
  resolveCanonicalDirectory,
} from '../../core/path-safety.js'

/**
 * Which local folders an agent may be given (docs/feature-local-folder-access.md,
 * SEC-2 and SEC-3).
 *
 * Two independent conditions. The person must have picked this exact folder in
 * the native dialog, which leaves a grant behind in the shared-folder grant
 * list (separate from Batch's, so neither feature's grants widen the other). And the folder must not overlap
 * the app's own data in either direction: a folder inside the workspace would
 * expose other chats, and a parent of it, such as the home folder, would
 * expose the same files one level down, where path containment alone admits
 * them.
 */

export type SharedFolderAdmission =
  | { readonly ok: true; readonly canonicalPath: string }
  | {
      readonly ok: false
      readonly code: 'not_a_folder' | 'not_granted' | 'protected_overlap'
      readonly message: string
    }

export interface SharedFolderAccessPolicyOptions {
  /** The app data folder and the workspace. Either may be absent on disk. */
  readonly protectedPaths: readonly string[]
  readonly listGrants: () => Promise<readonly string[]>
}

export class SharedFolderAccessPolicy {
  constructor(private readonly options: SharedFolderAccessPolicyOptions) {}

  async admitRoot(folderPath: string): Promise<SharedFolderAdmission> {
    const canonicalPath = await resolveCanonicalDirectory(folderPath)
    if (!canonicalPath) {
      return { ok: false, code: 'not_a_folder', message: 'The selected path is not a folder.' }
    }
    const protectedPaths = await this.canonicalProtectedPaths()
    // Only the app's own data and anything inside it is refused. A parent, such
    // as the home folder, can be shared: every tool call and walk refuses the
    // protected paths beneath it (isProtected).
    if (protectedPaths.some((protectedPath) => isPathEqualOrInside(protectedPath, canonicalPath))) {
      return {
        ok: false,
        code: 'protected_overlap',
        message: "This folder is part of the app's own data and can't be shared.",
      }
    }
    if (!await this.isRootGranted(canonicalPath)) {
      return {
        ok: false,
        code: 'not_granted',
        message: 'Choose this folder with Add folder before attaching it.',
      }
    }
    return { ok: true, canonicalPath }
  }

  /**
   * Whether an absolute path lies inside the app's data.
   *
   * The second check behind `admitRoot`, for tools reading beneath a root. It
   * resolves the candidate when it exists, so a symlink is judged by its target.
   */
  async isProtected(absolutePath: string): Promise<boolean> {
    const candidate = await fs.realpath(absolutePath).catch(() => path.resolve(absolutePath))
    const protectedPaths = await this.canonicalProtectedPaths()
    return protectedPaths.some((protectedPath) => isPathEqualOrInside(protectedPath, candidate))
  }

  /**
   * Read on every call, so a grant revoked a moment ago is already gone.
   *
   * Exact match only. A grant names the one folder the person picked in the
   * native dialog; treating it as covering its subfolders would let any API
   * caller attach a folder nobody picked.
   */
  async isRootGranted(canonicalPath: string): Promise<boolean> {
    const grants = await this.options.listGrants()
    return grants.includes(canonicalPath)
  }

  private async canonicalProtectedPaths(): Promise<string[]> {
    return Promise.all(
      this.options.protectedPaths.map((protectedPath) =>
        fs.realpath(protectedPath).catch(() => path.resolve(protectedPath))),
    )
  }
}
