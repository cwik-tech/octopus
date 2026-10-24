import * as z from "zod/v4";

const expectedGeneration = z.number().int().nonnegative();
const id = z.string().trim().min(1).max(256);
const changeNote = z.string().max(4000).default("");

export const resourceLibraryFileInputSchema = z.object({
  path: z.string().min(1),
  contentBase64: z.string(),
  executable: z.boolean().default(false),
});

const files = z.array(resourceLibraryFileInputSchema).min(1);

export const resourceLibraryCreateSkillRequestSchema = z.object({
  slug: z.string().trim().min(1).max(64),
  changeNote,
  expectedGeneration,
  files,
});

export const resourceLibrarySaveSkillRequestSchema = z.object({
  baseRevisionId: id,
  changeNote,
  expectedGeneration,
  files,
});

export const resourceLibraryRestoreSkillRequestSchema = z.object({
  sourceRevisionId: id,
  baseRevisionId: id,
  changeNote,
  expectedGeneration,
});

export const resourceLibraryArchiveSkillRequestSchema = z.object({
  archived: z.boolean(),
  expectedGeneration,
});

export const resourceLibraryAttachSkillRequestSchema = z.object({
  skillId: id,
  revisionId: id,
  alias: z.string().trim().min(1).max(64),
  expectedGeneration,
});

export const resourceLibraryDetachSkillRequestSchema = z.object({
  expectedGeneration,
});

export const resourceLibrarySelectRevisionRequestSchema = z.object({
  skillId: id,
  revisionId: id,
  expectedGeneration,
});

export type ResourceLibraryFileInput = z.infer<typeof resourceLibraryFileInputSchema>;
export type ResourceLibraryCreateSkillRequest = z.infer<typeof resourceLibraryCreateSkillRequestSchema>;
export type ResourceLibrarySaveSkillRequest = z.infer<typeof resourceLibrarySaveSkillRequestSchema>;
export type ResourceLibraryRestoreSkillRequest = z.infer<typeof resourceLibraryRestoreSkillRequestSchema>;
export type ResourceLibraryArchiveSkillRequest = z.infer<typeof resourceLibraryArchiveSkillRequestSchema>;
export type ResourceLibraryAttachSkillRequest = z.infer<typeof resourceLibraryAttachSkillRequestSchema>;
export type ResourceLibraryDetachSkillRequest = z.infer<typeof resourceLibraryDetachSkillRequestSchema>;
export type ResourceLibrarySelectRevisionRequest = z.infer<typeof resourceLibrarySelectRevisionRequestSchema>;
