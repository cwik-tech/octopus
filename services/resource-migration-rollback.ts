import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResourceLibraryStore } from '../domains/resource-library/resource-library-store.js';
import { resourceMigrationReportSchema } from '../contracts/resource-migration.js';
import { digestResourceFile, digestResourceSkillFiles, normalizeResourcePath, readResourceSkillFiles } from '../domains/resource-library/skill-files.js';

export async function rollbackResourceMigration(input: { store: ResourceLibraryStore; repoRoot: string; libraryRoot: string; backupPath: string }): Promise<void> {
  const value: unknown = JSON.parse(await fs.readFile(path.join(input.backupPath, 'inventory.json'), 'utf8'));
  const report = resourceMigrationReportSchema.parse(value);
  if (report.sourceRootDigest !== digestResourceFile(Buffer.from(path.resolve(input.repoRoot)))) throw new Error('Backup belongs to a different source project');
  await input.store.withPublicationLock(async () => {
    const catalog = await input.store.getSnapshot();
    if (report.expectedGeneration !== 0 || catalog.generation !== 1 || catalog.packages.length || !catalog.migrationReceipt) throw new Error('Library has been used or changed; rollback would discard a later generation');
    const retained = await fs.readdir(path.join(input.repoRoot, 'agents/.resource-library-tasks')).catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; });
    if (retained.length) throw new Error('Library has been used by a retained execution; keep its snapshots and recover from the backup separately');
    for (const source of report.sources) {
      const receipt = catalog.migrationReceipt.sources.find((item) => item.path === source.path && item.digest === source.digest);
      if (!receipt) throw new Error('Backup does not match the migrated catalog');
      const files = await readResourceSkillFiles(path.join(input.backupPath, 'sources', normalizeResourcePath(source.path)));
      if (!files || digestResourceSkillFiles(files) !== source.digest) throw new Error('Migration backup checksum mismatch');
    }
    const archive = path.join(input.libraryRoot, 'rollback-pointers'); await fs.mkdir(archive, { recursive: true, mode: 0o700 });
    // Retain the pointer and every immutable revision; no personal source file is rewritten.
    await fs.rename(path.join(input.libraryRoot, 'current.json'), path.join(archive, `${randomUUID()}.json`));
  });
}
