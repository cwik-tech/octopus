import { builtInUpdateOfferSchema } from "./builtin-update.js";
import * as z from 'zod/v4';
import { portableIdSchema } from './resource-package.js';
import { resourceLibraryFileManifestSchema } from './resource-library-file.js';
export const builtInSelectionSchema = z.object({
  schemaVersion: z.literal(1), agents: z.array(portableIdSchema), teams: z.array(portableIdSchema), skills: z.array(portableIdSchema),
  workflowTemplates: z.array(z.string().regex(/^[a-zA-Z0-9_-]+\.yaml$/)), entryTeam: portableIdSchema.nullable(),
});
export const builtInBundleSchema = z.object({
  schemaVersion: z.literal(1), appVersion: z.string(), buildId: z.string().regex(/^[a-f0-9]{32}$/),
  resources: z.array(z.object({ path: z.string(), kind: z.enum(['file', 'directory']), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), files: z.array(resourceLibraryFileManifestSchema) })),
});
export const builtInInstallReceiptSchema = z.object({
  schemaVersion: z.literal(1), buildId: z.string().regex(/^[a-f0-9]{32}$/),
  resources: z.array(z.object({ path: z.string(), sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), removed: z.boolean() })),
  offeredUpdates: z.array(builtInUpdateOfferSchema),
});
export type BuiltInSelection = z.infer<typeof builtInSelectionSchema>;
export type BuiltInBundle = z.infer<typeof builtInBundleSchema>;
export type BuiltInInstallReceipt = z.infer<typeof builtInInstallReceiptSchema>;
