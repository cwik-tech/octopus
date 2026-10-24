import * as z from 'zod/v4';
import { resourceLibraryDigestSchema } from './resource-library-file.js';
export const builtInUpdateOfferSchema = z.object({ path: z.string().min(1), digest: resourceLibraryDigestSchema, appVersion: z.string(), kind: z.enum(['file', 'directory']) });
export const builtInUpdateSourceSchema = builtInUpdateOfferSchema.pick({ path: true, digest: true });
export type BuiltInUpdateSource = z.infer<typeof builtInUpdateSourceSchema>;
