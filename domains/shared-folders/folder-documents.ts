import * as path from 'node:path'

import type { FolderDocuments, FolderWalk } from './folder-access.js'
import {
  isFolderDocument,
  type FolderDocumentScan,
  type FolderIndex,
  type FolderIndexStatus,
} from './folder-index.js'

/**
 * What folder tools, the folder map and turn-start freshness need of the
 * document cache (docs/feature-local-folder-access.md, "Indexing and the parse
 * cache" and "Freshness").
 *
 * Reads go through `FolderDocuments`, after folder access has checked the
 * source file. `refresh` is the per-turn freshness check: the walk the folder
 * map makes anyway is handed to the index, so changed documents go back to
 * pending and deleted ones are dropped without a second walk.
 */
export interface FolderDocumentIndex extends FolderDocuments {
  refresh(root: string, walk: FolderWalk): Promise<FolderIndexStatus>
}

/**
 * The documents a walk found, measured as the index compares them. A walk
 * stopped by a limit, or one that met a folder or file it could not read, did
 * not see the whole folder, so the index keeps a document it missed until
 * that document is gone from disk.
 */
export function documentScanOf(walk: FolderWalk): FolderDocumentScan {
  return {
    documents: walk.files
      .filter((file) => isFolderDocument(path.posix.basename(file.path)))
      .map((file) => ({ path: file.path, size: file.size ?? 0, mtimeMs: Date.parse(file.modifiedAt) })),
    complete: !walk.truncated && walk.unreadableFolders.length === 0 && walk.unreadableFiles.length === 0,
  }
}

export function folderIndexDocuments(index: FolderIndex): FolderDocumentIndex {
  return {
    isDocument: isFolderDocument,
    readDocument: (root, document, options) => index.readDocument(root, document, options),
    readCached: (root, document, options) => index.readCached(root, document, options),
    async refresh(root, walk) {
      await index.reconcile(root, documentScanOf(walk))
      return index.status(root)
    },
  }
}
