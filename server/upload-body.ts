/**
 * The raw-body upload transport the session, project, and team file routes
 * share: the file name arrives in the `x-filename` header and the file bytes
 * are the whole request body.
 */
import type * as http from "node:http";

import { ApiRequestError } from "./http.js";

/** The largest upload body accepted, 25 MiB. */
export const UPLOAD_MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Reads the whole request body. Throws a 413 ApiRequestError once the bytes
 * received pass UPLOAD_MAX_BODY_BYTES.
 */
export async function readUploadBody(
  req: http.IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > UPLOAD_MAX_BODY_BYTES) {
      throw new ApiRequestError("Upload exceeds 25MB limit", 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Returns the first `x-filename` header value as sent, still percent-encoded,
 * or null when the header is missing or empty.
 */
export function readFilenameHeader(req: http.IncomingMessage): string | null {
  const filenameHeader = req.headers["x-filename"];
  const rawFilename = Array.isArray(filenameHeader)
    ? filenameHeader[0]
    : filenameHeader;
  return rawFilename && typeof rawFilename === "string" ? rawFilename : null;
}
