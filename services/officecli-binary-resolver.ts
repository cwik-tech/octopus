import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { OFFICE_MANIFEST_FILE, OFFICE_TOOLS_DIRECTORY, officeBinaryManifestSchema } from '../contracts/office-documents.js'
import { readOfficeFile } from './office-preview-source.js'

/** No PATH lookup, runtime download, unpinned binary or machine-global fallback. */
export async function resolveOfficeBinary(repoRoot: string, signal: AbortSignal): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const resources = 'resourcesPath' in process && typeof process.resourcesPath === 'string' ? [path.join(process.resourcesPath, OFFICE_TOOLS_DIRECTORY)] : []
  const roots = [...resources, path.join(repoRoot, 'build', OFFICE_TOOLS_DIRECTORY), path.resolve(repoRoot, '..', OFFICE_TOOLS_DIRECTORY)]
  for (const root of roots) {
    const directory = path.join(root, `${process.platform}-${process.arch}`)
    try {
      const manifestBytes = await readOfficeFile(path.join(directory, OFFICE_MANIFEST_FILE), 4096, signal)
      const raw: unknown = JSON.parse(manifestBytes.toString('utf8'))
      const manifest = officeBinaryManifestSchema.parse(raw)
      const pins: Readonly<Record<string, string>> = { 'darwin-arm64': '0dae0990a9cc29688a5d54469f984c34e5b15ab6bbd194a0ffdc571bb9040124', 'darwin-x64': '178c1e9ebaf44c24d2b4b359064a5dea6eb7b2f539809871a3de1c09599dff9f' }
      if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.upstreamSha256 !== pins[`${process.platform}-${process.arch}`]) return undefined
      const file = path.join(directory, manifest.file)
      if (await fs.realpath(file) !== file) return undefined
      const bytes = await readOfficeFile(file, 128 * 1024 * 1024, signal)
      if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) return undefined
      return file
    } catch (error) {
      if (signal.aborted) throw error
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return undefined
    }
  }
  return undefined
}
