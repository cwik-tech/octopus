import { builtInUpdateOfferSchema, builtInUpdateSourceSchema } from "./builtin-update.js";
import * as z from "zod/v4";

const idSchema = z.string().min(1).max(256);
import { resourceLibraryDigestSchema as digestSchema, resourceLibraryFileManifestSchema } from './resource-library-file.js';
import { resourceMigrationReportSchema } from './resource-migration.js';
export { resourceLibraryFileManifestSchema } from './resource-library-file.js';
const timestampSchema = z.string().datetime({ offset: true });


export const resourceLibrarySkillRevisionSchema = z.object({
  id: idSchema,
  sequence: z.number().int().positive(),
  parentRevisionId: idSchema.nullable(),
  digest: digestSchema,
  createdAt: timestampSchema,
  changeNote: z.string().max(4000),
  restoredFromRevisionId: idSchema.optional(),
  files: z.array(resourceLibraryFileManifestSchema),
});

export const resourceLibrarySkillSchema = z.object({
  id: idSchema,
  slug: z.string().min(1).max(64),
  displayName: z.string().min(1).max(256),
  description: z.string().max(1024),
  origin: z.enum(["legacy", "library", "import", "built-in"]),
  provenance: z.array(z.string()),
  archived: z.boolean(),
  currentRevisionId: idSchema,
  revisions: z.array(resourceLibrarySkillRevisionSchema).min(1),
});

export const resourceLibraryAttachmentSchema = z.object({
  agentId: idSchema,
  skillId: idSchema,
  revisionId: idSchema,
  alias: z.string().min(1).max(64),
});

export const resourceLibraryAgentSchema = z.object({
  id: idSchema,
  attachments: z.array(resourceLibraryAttachmentSchema),
});

export const resourceLibraryTeamSchema = z.object({
  id: idSchema,
  agentIds: z.array(idSchema),
});

export const resourceLibraryPackageSchema = z.object({
  id: idSchema,
  version: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  origin: z.string().min(1),
  digest: digestSchema,
  resourceIds: z.array(idSchema),
  installedAt: timestampSchema,
  receipt: z.string(),
  builtinSource: builtInUpdateSourceSchema.optional(),
  installedDigest: digestSchema.optional(),
});

export const resourceLibraryMigrationSourceSchema = z.object({
  path: z.string().min(1),
  skillId: idSchema,
  revisionId: idSchema,
  digest: digestSchema,
});

export const resourceLibraryMigrationReceiptSchema = z.object({
  version: z.literal(1),
  migratedAt: timestampSchema,
  importedSourceCount: z.number().int().nonnegative(),
  logicalSkillCount: z.number().int().nonnegative(),
  agentCount: z.number().int().nonnegative(),
  sources: z.array(resourceLibraryMigrationSourceSchema),
});

export const resourceLibraryCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().nonnegative(),
  generationId: idSchema,
  skills: z.array(resourceLibrarySkillSchema),
  agents: z.array(resourceLibraryAgentSchema),
  teams: z.array(resourceLibraryTeamSchema),
  packages: z.array(resourceLibraryPackageSchema),
  migrationReceipt: resourceLibraryMigrationReceiptSchema.optional(),
});

export const resourceLibraryCurrentPointerSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: idSchema,
});

export type ResourceLibraryFileManifest = z.infer<typeof resourceLibraryFileManifestSchema>;
export type ResourceLibrarySkillRevision = z.infer<typeof resourceLibrarySkillRevisionSchema>;
export type ResourceLibrarySkill = z.infer<typeof resourceLibrarySkillSchema>;
export type ResourceLibraryAttachment = z.infer<typeof resourceLibraryAttachmentSchema>;
export type ResourceLibraryAgent = z.infer<typeof resourceLibraryAgentSchema>;
export type ResourceLibraryTeam = z.infer<typeof resourceLibraryTeamSchema>;
export type ResourceLibraryPackage = z.infer<typeof resourceLibraryPackageSchema>;
export type ResourceLibraryMigrationReceipt = z.infer<typeof resourceLibraryMigrationReceiptSchema>;
export type ResourceLibraryCatalog = z.infer<typeof resourceLibraryCatalogSchema>;
export type ResourceLibrarySnapshot = ResourceLibraryCatalog;

export interface ResourceLibraryMigrationResult {
  alreadyMigrated: boolean;
  generationId: string;
  importedSourceCount: number;
  logicalSkillCount: number;
}

const libraryAgentDetailSchema = z.object({
  name: z.string(), description: z.string().optional(), tier: z.string().optional(),
  model: z.string().optional(), provider: z.string().optional(), thinking: z.string().optional(),
  skills: z.array(z.string()),
  usedInTeams: z.array(z.object({ teamId: z.string(), teamName: z.string() })),
  browserEnabled: z.boolean().optional(), uiHidden: z.boolean().optional(), system: z.boolean().optional(),
});

const libraryTeamDetailSchema = z.object({
  id: z.string(), name: z.string(), description: z.string().optional(),
  tags: z.array(z.string()), agentCount: z.number().int().nonnegative(),
  agents: z.array(z.object({ name: z.string(), role: z.string() })),
});

export const resourceLibraryBrowserSnapshotSchema = resourceLibraryCatalogSchema.extend({
  agentDetails: z.array(libraryAgentDetailSchema), teamDetails: z.array(libraryTeamDetailSchema),
  migrationPending: resourceMigrationReportSchema.optional(),
  builtInUpdates: z.array(builtInUpdateOfferSchema).optional(),
});
export const resourceLibraryRevisionFileSchema = z.object({
  path: z.string().min(1), contentBase64: z.string(), executable: z.boolean(),
});
export const resourceLibraryRevisionFilesSchema = z.object({ files: z.array(resourceLibraryRevisionFileSchema) });
export const resourceLibrarySkillMutationSchema = z.object({
  skill: resourceLibrarySkillSchema, revision: resourceLibrarySkillRevisionSchema, unchanged: z.boolean(),
});
export const resourceLibraryArchiveResultSchema = z.object({ skill: resourceLibrarySkillSchema, unchanged: z.boolean() });
export type ResourceLibraryBrowserSnapshot = z.infer<typeof resourceLibraryBrowserSnapshotSchema>;
export type ResourceLibraryRevisionFile = z.infer<typeof resourceLibraryRevisionFileSchema>;
export type ResourceLibraryRevisionFiles = z.infer<typeof resourceLibraryRevisionFilesSchema>;

export type ResourceLibrarySkillMutation = z.infer<typeof resourceLibrarySkillMutationSchema>;
export type ResourceLibraryArchiveResult = z.infer<typeof resourceLibraryArchiveResultSchema>;
