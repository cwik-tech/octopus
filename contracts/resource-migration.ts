import * as z from 'zod/v4';
import { resourceLibraryFileManifestSchema } from './resource-library-file.js';
export const resourceMigrationReportSchema = z.object({
  schemaVersion: z.literal(1), sourceRootDigest: z.string(), inventoryDigest: z.string(), expectedGeneration: z.number().int().nonnegative(), alreadyMigrated: z.boolean(),
  agentIds: z.array(z.string()), sources: z.array(z.object({ path: z.string(), agentId: z.string().optional(), slug: z.string(), digest: z.string(), files: z.array(resourceLibraryFileManifestSchema) })),
});
export type ResourceMigrationReport = z.infer<typeof resourceMigrationReportSchema>;

export const resourceMigrationApprovalSchema = z.object({ inventoryDigest: z.string(), expectedGeneration: z.number().int().nonnegative() });
export const resourceMigrationApprovalResultSchema = z.object({ backupPath: z.string() });
