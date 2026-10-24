import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ResourceMigrationReport } from '../contracts/resource-migration.js';
import { resourceMigrationReportSchema } from '../contracts/resource-migration.js';
import { digestResourceSkillFiles, normalizeResourcePath, readResourceSkillFiles, writeResourceSkillFiles } from '../domains/resource-library/skill-files.js';
import { packageIdentity } from '../domains/resource-library/resource-package-format.js';

export async function createResourceMigrationBackup(input: { repoRoot: string; libraryRoot: string; report: ResourceMigrationReport; signal?: AbortSignal }): Promise<string> {
  const backupPath = path.join(input.libraryRoot, 'backups', packageIdentity(input.report.inventoryDigest));
  await fs.mkdir(backupPath, { recursive: true, mode: 0o700 }); await fs.chmod(backupPath, 0o700);
  for (const source of input.report.sources) {
    input.signal?.throwIfAborted();
    const relative = normalizeResourcePath(source.path);
    const files = await readResourceSkillFiles(path.join(input.repoRoot, relative));
    if (!files || digestResourceSkillFiles(files) !== source.digest) throw new Error('Migration source changed during backup; review again');
    const target = path.join(backupPath, 'sources', relative);
    const prior = await readResourceSkillFiles(target);
    if (prior) { if (digestResourceSkillFiles(prior) !== source.digest) throw new Error('Existing migration backup was changed; retain it and choose a fresh backup'); continue; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const staging = `${target}.staging-${randomUUID()}`;
    try { await writeResourceSkillFiles(files, staging); input.signal?.throwIfAborted(); await fs.rename(staging, target); }
    finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  input.signal?.throwIfAborted();
  const reportPath = path.join(backupPath, 'inventory.json');
  try { await fs.writeFile(reportPath, JSON.stringify(input.report, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const value: unknown = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    if (resourceMigrationReportSchema.parse(value).inventoryDigest !== input.report.inventoryDigest) throw new Error('Migration backup inventory does not match');
  }
  return backupPath;
}
