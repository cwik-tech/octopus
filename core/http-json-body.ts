import type * as http from "node:http";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function readJsonBody(
  req: http.IncomingMessage,
  maxBodyBytes = 1024 * 1024,
): Promise<unknown> {
  // CSRF hardening: cross-origin form posts can only send a safelisted
  // content-type (text/plain, form-urlencoded, multipart). Refusing to parse
  // those as JSON blocks drive-by state changes against the loopback API.
  // Requests with no content-type are accepted only when the body is empty.
  const contentType = req.headers["content-type"];
  if (
    contentType !== undefined &&
    (typeof contentType !== "string" ||
      !/^\s*application\/(.+\+)?json\b/i.test(contentType))
  ) {
    throw new ApiRequestError(
      "Content-Type must be application/json",
      415,
    );
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new ApiRequestError(
        `Request body exceeds ${formatByteLimit(maxBodyBytes)} limit`,
        413,
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  if (contentType === undefined) {
    throw new ApiRequestError(
      "Content-Type must be application/json",
      415,
    );
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiRequestError("Invalid JSON request body", 400);
  }
}

function formatByteLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes}-byte`;
}
