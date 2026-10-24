import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from '../../core/file-mutation.js';
import { digestResourceFile, digestResourceSkillFiles, readResourceSkillFiles, writeResourceSkillFiles, type ResourceSkillFiles } from './skill-files.js';

const ownerFile = '.octopus-import-owner';
const journalSchema = z.object({
  generationId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  registry: z.object({ beforeBase64: z.string().base64().nullable(), afterDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).optional(),
  resources: z.array(z.object({ destination: z.string().regex(/^(agents|teams)\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) })),
});
const journalPath = (root: string) => path.join(root, 'package-publication.json');

export async function publishImportedResources(input: {
  repoRoot: string; libraryRoot: string; generationId: string; resources: ReadonlyMap<string, ResourceSkillFiles>;
  registry?: { before: Buffer | null; after: Buffer };
  publish(): Promise<void>; isPublished(): Promise<boolean>;
}): Promise<void> {
  if (!input.resources.size && !input.registry) { await input.publish(); return; }
  const journal = journalSchema.parse({ generationId: input.generationId, ...(input.registry ? { registry: { beforeBase64: input.registry.before?.toString('base64') ?? null, afterDigest: digestResourceFile(input.registry.after) } } : {}), resources: [...input.resources].map(([destination, files]) => ({ destination, digest: digestResourceSkillFiles(files) })) });
  const staging = path.join(input.repoRoot, '.resource-library-package-staging', journal.generationId);
  await fs.mkdir(staging, { recursive: true });
  let journalWritten = false;
  try {
    for (const resource of journal.resources) {
      const existing = await fs.lstat(path.join(input.repoRoot, resource.destination)).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error;
      });
      if (existing) throw new Error(`Resource already exists: ${resource.destination}`);
      const files = input.resources.get(resource.destination);
      if (!files) throw new Error('Missing package resource');
      const target = path.join(staging, resource.destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await writeResourceSkillFiles(files, target);
      await fs.writeFile(path.join(target, ownerFile), journal.generationId, { flag: 'wx' });
    }
    await writeFileAtomic(journalPath(input.libraryRoot), JSON.stringify(journal)); journalWritten = true;
    for (const resource of journal.resources) {
      const target = path.join(input.repoRoot, resource.destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Targets are new identities only; no existing resource is replaced.
      if (await fs.lstat(target).then(() => true, (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error;
      })) throw new Error(`Resource collision: ${resource.destination}`);
      await fs.rename(path.join(staging, resource.destination), target);
    }
    if (input.registry) {
      const current = await readRegistry(input.repoRoot);
      if (!sameBytes(current, input.registry.before)) throw new Error('Team registry changed during import; files retained for review');
      await writeFileAtomic(path.join(input.repoRoot, 'teams.yaml'), input.registry.after);
    }
    await input.publish();
    await recoverImportedResources(input.repoRoot, input.libraryRoot, journal.generationId);
  } catch (error) {
    if (journalWritten) {
      await recoverImportedResources(input.repoRoot, input.libraryRoot, await input.isPublished() ? journal.generationId : 'unpublished');
    }
    throw error;
  } finally { if (!journalWritten) await fs.rm(staging, { recursive: true, force: true }); }
}

export async function recoverImportedResources(repoRoot: string, libraryRoot: string, generationId: string): Promise<void> {
  const source = await fs.readFile(journalPath(libraryRoot), 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error;
  });
  if (source === null) return;
  const value: unknown = JSON.parse(source);
  const journal = journalSchema.parse(value);
  const owned: string[] = [];
  const committed = generationId === journal.generationId;
  for (const resource of journal.resources) {
    const target = path.join(repoRoot, resource.destination);
    const marker = await fs.readFile(path.join(target, ownerFile), 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error;
    });
    if (marker !== journal.generationId) continue;
    if (!committed) {
      const files = await readResourceSkillFiles(target); if (!files) continue;
      const contents = new Map(files); contents.delete(ownerFile);
      if (digestResourceSkillFiles(contents) !== resource.digest) throw new Error(`Interrupted import has external drift; files retained: ${resource.destination}`);
    }
    owned.push(target);
  }
  let restoreRegistry = false;
  if (!committed && journal.registry) {
    const current = await readRegistry(repoRoot);
    const before = journal.registry.beforeBase64 === null ? null : Buffer.from(journal.registry.beforeBase64, 'base64');
    restoreRegistry = current !== null && digestResourceFile(current) === journal.registry.afterDigest;
    if (!restoreRegistry && !sameBytes(current, before)) throw new Error('Interrupted import registry has external drift; files retained');
    if (restoreRegistry) {
      if (before === null) await fs.rm(path.join(repoRoot, 'teams.yaml'));
      else await writeFileAtomic(path.join(repoRoot, 'teams.yaml'), before);
    }
  }
  for (const target of owned) {
    if (committed) await fs.rm(path.join(target, ownerFile));
    else await fs.rm(target, { recursive: true });
  }
  await fs.rm(path.join(repoRoot, '.resource-library-package-staging', journal.generationId), { recursive: true, force: true });
  await fs.rm(journalPath(libraryRoot));
}

async function readRegistry(repoRoot: string): Promise<Buffer | null> {
  const file = path.join(repoRoot, 'teams.yaml');
  const stat = await fs.lstat(file).catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Team registry has external drift; expected a regular file');
  return fs.readFile(file);
}
function sameBytes(left: Buffer | null, right: Buffer | null): boolean { return left === null ? right === null : right !== null && left.equals(right); }
