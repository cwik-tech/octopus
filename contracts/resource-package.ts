import { builtInUpdateSourceSchema } from "./builtin-update.js";
import * as z from 'zod/v4';
import { resourceLibrarySkillSchema, resourceLibraryAttachmentSchema, resourceLibraryFileManifestSchema } from './resource-library.js';

export const portableIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const resourcePackageManifestSchema = z.object({
  schemaVersion: z.literal(1), id: portableIdSchema, version: z.string().min(1).max(64), origin: z.string().max(256),
  skills: z.array(resourceLibrarySkillSchema),
  agents: z.array(z.object({ id: portableIdSchema, attachments: z.array(resourceLibraryAttachmentSchema) })),
  teams: z.array(z.object({ id: portableIdSchema, agentIds: z.array(portableIdSchema), teamIds: z.array(portableIdSchema).default([]), internal: z.boolean().default(false) })),
  files: z.array(resourceLibraryFileManifestSchema),
});
export const resourcePackageResolutionSchema = z.object({
  sourceId: z.string(), mode: z.enum(['fork', 'revision', 'reuse']), targetSkillId: z.string().optional(), revisionId: z.string().optional(),
});
export const resourcePackagePreviewSchema = z.object({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), expectedGeneration: z.number().int().nonnegative(), filename: z.string(),
  packageId: z.string(), alreadyImported: z.boolean().optional(),
  skills: z.array(z.object({
    sourceId: z.string(), slug: z.string(), revisionCount: z.number().int().positive(),
    conflict: z.enum(['new', 'identical', 'name', 'identity']),
    existingSkills: z.array(z.object({ id: z.string(), label: z.string(), revisionId: z.string() })),
  })),
  agents: z.array(z.object({ id: z.string(), targetId: z.string() })),
  teams: z.array(z.object({ id: z.string(), targetId: z.string() })), warnings: z.array(z.string()),
});
export const resourcePackageCommitSchema = z.object({
  contentBase64: z.string().base64().max(89_478_488), filename: z.string().min(1).max(256), digest: z.string(), expectedGeneration: z.number().int().nonnegative(),
  resolutions: z.array(resourcePackageResolutionSchema),
  builtinUpdate: builtInUpdateSourceSchema.optional(),
  runtimeTargets: z.object({ agents: z.array(z.object({ id: portableIdSchema, targetId: portableIdSchema })), teams: z.array(z.object({ id: portableIdSchema, targetId: portableIdSchema })) }).optional(),
});
export const resourcePackageExportSchema = z.object({
  kind: z.enum(['skill', 'agent', 'team', 'package']), id: z.string().min(1), format: z.enum(['skill', 'octopus']), includeHistory: z.boolean(),
});
export type ResourcePackageManifest = z.infer<typeof resourcePackageManifestSchema>;
export type ResourcePackagePreview = z.infer<typeof resourcePackagePreviewSchema>;
export type ResourcePackageResolution = z.infer<typeof resourcePackageResolutionSchema>;
export type ResourcePackageExport = z.infer<typeof resourcePackageExportSchema>;

export const resourcePackagePreviewRequestSchema = resourcePackageCommitSchema.pick({ contentBase64: true, filename: true });
export const resourcePackageCommitResultSchema = z.object({ unchanged: z.boolean(), packageId: z.string() });
export const resourcePackageExportResultSchema = z.object({ filename: z.string(), contentBase64: z.string().base64() });
