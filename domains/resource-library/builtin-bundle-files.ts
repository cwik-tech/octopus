import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BuiltInBundle } from '../../contracts/builtin-resources.js';
import { normalizeResourcePath, digestResourceFile, digestResourceSkillFiles, type ResourceSkillFile } from './skill-files.js';
import { isPrivateResourcePath } from './portable-resources.js';
export async function verifyBuiltinFiles(root: string, manifest: BuiltInBundle): Promise<ReadonlyMap<string, Buffer>> {
  const verified = new Map<string, Buffer>();
  for (const resource of manifest.resources) {
    normalizeResourcePath(resource.path);
    const contents = new Map<string, ResourceSkillFile>();
    for (const file of resource.files) {
      const name = normalizeResourcePath(file.path);
      if ((resource.kind === 'file' ? name !== resource.path : !name.startsWith(`${resource.path}/`)) || verified.has(name) || isPrivateResourcePath(name)) throw new Error('Invalid or duplicate built-in file');
      await assertNoSymlinkParents(root, name);
      const original = path.join(root, name); const stat = await fs.lstat(original);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid bundled file: ${name}`);
      const bytes = await fs.readFile(original);
      if (digestResourceFile(bytes) !== file.sha256 || bytes.length !== file.sizeBytes) throw new Error(`Bundled checksum mismatch: ${name}`);
      verified.set(name, bytes);
      contents.set(resource.kind === 'file' ? path.posix.basename(name) : name.slice(resource.path.length + 1), { contents: bytes, mode: file.executable ? 0o755 : 0o644, executable: file.executable });
    }
    if (!contents.size || digestResourceSkillFiles(contents) !== resource.digest) throw new Error(`Bundled resource checksum mismatch: ${resource.path}`);
  }
  return verified;
}
export async function assertNoSymlinkParents(root: string, name: string): Promise<void> {
  let current = root;
  for (const segment of name.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error(`Built-in path cannot traverse a symbolic link: ${name}`);
  }
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
