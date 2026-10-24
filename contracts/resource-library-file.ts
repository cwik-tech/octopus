import * as z from 'zod/v4';
export const resourceLibraryDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const resourceLibraryFileManifestSchema = z.object({
  path: z.string().min(1),
  sha256: resourceLibraryDigestSchema,
  sizeBytes: z.number().int().nonnegative(),
  executable: z.boolean(),
});

