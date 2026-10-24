import { z } from 'zod'

/**
 * Local folders shared with agents (docs/feature-local-folder-access.md).
 *
 * A folder ID is a label the agent uses inside one turn. It is never authority:
 * the server resolves which folders a turn may touch, and a tool refuses any ID
 * outside that list.
 */

export const SHARED_FOLDERS_PER_OWNER_LIMIT = 10

export const sharedFolderIdSchema = z.string().regex(/^f_[a-z0-9]{10}$/)

export const sharedFolderRecordSchema = z.strictObject({
  version: z.literal(1),
  id: sharedFolderIdSchema,
  /** Canonical absolute path, resolved when the folder was attached. */
  path: z.string().min(1).max(4096),
  label: z.string().min(1).max(255),
  /** `read-write` is reserved for a later version. */
  access: z.literal('read'),
  addedAt: z.iso.datetime(),
})
export type SharedFolderRecord = z.infer<typeof sharedFolderRecordSchema>

export const sharedFolderListFileSchema = z.strictObject({
  version: z.literal(1),
  folders: z.array(sharedFolderRecordSchema).max(SHARED_FOLDERS_PER_OWNER_LIMIT),
})
export type SharedFolderListFile = z.infer<typeof sharedFolderListFileSchema>

export const attachSharedFolderRequestSchema = z.strictObject({
  path: z.string().min(1).max(4096),
})

/**
 * A folder's state as the UI shows it (docs/feature-local-folder-access.md,
 * "Status"). Computed from the folder index and a check of the root, never
 * from a full walk on each request.
 */
export const sharedFolderStatusSchema = z.strictObject({
  state: z.enum(['indexing', 'ready', 'partial', 'unavailable']),
  /** Set when state is unavailable. */
  reason: z.enum(['not_found', 'access_removed', 'unreadable']).optional(),
  /** Eligible files found by the last scan. */
  files: z.number().int().nonnegative().optional(),
  /** Documents still waiting to be parsed. */
  pendingDocuments: z.number().int().nonnegative().optional(),
  /** Set when state is partial: which limit stopped the scan or parsing, in plain words. */
  limit: z.string().max(200).optional(),
})
export type SharedFolderStatus = z.infer<typeof sharedFolderStatusSchema>

export const sharedFolderViewSchema = z.strictObject({
  id: sharedFolderIdSchema,
  label: z.string(),
  path: z.string(),
  source: z.enum(['session', 'project']),
  addedAt: z.iso.datetime(),
  /** Set when `source` is `project`: the project that shares the folder. */
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  /** Phase 3: present on every folder list response once the index exists. */
  status: sharedFolderStatusSchema.optional(),
})
export type SharedFolderView = z.infer<typeof sharedFolderViewSchema>

export const sharedFolderListResponseSchema = z.strictObject({
  folders: z.array(sharedFolderViewSchema),
})

/**
 * Phase 2 API (docs/feature-local-folder-access.md, Flows A and B):
 * - GET /sessions/:id/folders lists the chat's project folders first
 *   (source "project", with projectId and projectName), then its own.
 * - POST /sessions/:id/folders with a folder the chat's project already shares
 *   answers 409 with code SHARED_FOLDER_ALREADY_IN_PROJECT.
 * - GET /projects/:id/folders, POST /projects/:id/folders { path },
 *   DELETE /projects/:id/folders/:folderId mirror the session routes; a project
 *   holds up to SHARED_FOLDERS_PER_OWNER_LIMIT folders (409 shared_folder_limit).
 */
export const SHARED_FOLDER_ALREADY_IN_PROJECT = 'already_in_project'

/**
 * Settings: GET and DELETE /settings/shared-folder-grants, the folders the
 * person picked for sharing. Kept apart from Batch's grant list. Revoking a
 * grant stops the next folder tool call; the folder stays attached until it is
 * removed from its chat or project.
 */
export const sharedFolderGrantListResponseSchema = z.strictObject({
  grants: z.array(z.strictObject({ path: z.string() })),
})
export type SharedFolderGrantView = z.infer<typeof sharedFolderGrantListResponseSchema>['grants'][number]

export const revokeSharedFolderGrantRequestSchema = z.strictObject({
  path: z.string().max(4096).refine(
    (value) => value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\'),
    'The path must be absolute.',
  ),
})
