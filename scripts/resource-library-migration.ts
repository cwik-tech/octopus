import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as z from 'zod/v4';
import { ResourceLibraryService } from '../services/resource-library-service.js';
import { resourceMigrationReportSchema } from '../contracts/resource-migration.js';
import { rollbackResourceMigration } from '../services/resource-migration-rollback.js';

const argumentSchema = z.object({ command: z.enum(['dry-run', 'apply', 'rollback']), 'repo-root': z.string().min(1), 'library-root': z.string().min(1), report: z.string().optional(), backup: z.string().optional() }).strict();
async function main(): Promise<void> {
  const [command, ...tokens] = process.argv.slice(2);
  const values: Record<string, unknown> = { command };
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index]; const value = tokens[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Use explicit --repo-root, --library-root and --report/--backup arguments');
    if (Object.hasOwn(values, key.slice(2))) throw new Error(`Duplicate argument: ${key}`);
    values[key.slice(2)] = value;
  }
  const args = argumentSchema.parse(values);
  const repoRootPath = path.resolve(args['repo-root']); const rootPath = path.resolve(args['library-root']);
  const service = new ResourceLibraryService({ repoRootPath, rootPath, requireMigrationApproval: true });
  if (args.command === 'dry-run') {
    if (!args.report) throw new Error('dry-run requires --report <new-file.json>');
    const report = await service.store.previewLegacyMigration();
    await fs.writeFile(args.report, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ status: 'review_required', report: args.report, sources: report.sources.length, agents: report.agentIds.length, inventoryDigest: report.inventoryDigest })}\n`);
  } else if (args.command === 'apply') {
    if (!args.report) throw new Error('apply requires the reviewed --report <file.json>');
    const value: unknown = JSON.parse(await fs.readFile(args.report, 'utf8')); const report = resourceMigrationReportSchema.parse(value);
    const current = await service.store.previewLegacyMigration();
    if (current.sourceRootDigest !== report.sourceRootDigest) throw new Error('Report belongs to a different source project');
    const result = await service.approveMigration({ inventoryDigest: report.inventoryDigest, expectedGeneration: report.expectedGeneration });
    process.stdout.write(`${JSON.stringify({ status: 'enabled', backup: result.backupPath })}\n`);
  } else {
    if (!args.backup) throw new Error('rollback requires --backup <verified-backup-directory>');
    await rollbackResourceMigration({ store: service.store, repoRoot: repoRootPath, libraryRoot: rootPath, backupPath: path.resolve(args.backup) });
    process.stdout.write(`${JSON.stringify({ status: 'rolled_back', note: 'Source files and immutable revisions are retained. Library requires approval again.' })}\n`);
  }
}
try { await main(); }
catch (error) { process.stderr.write(`${JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; }
