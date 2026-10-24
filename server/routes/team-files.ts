import type * as http from "node:http";
import { projectDocumentReviews } from '../../services/document-review-projection.js';
import * as path from 'node:path';
import { URL } from "node:url";

import { unsupportedUploadMessage } from "../../contracts/uploadable-formats.js";
import type { FileParserLauncher } from "../../core/file-parser-launcher.js";
import { decodeSafePathSegment } from "../../core/path-safety.js";
import {
  TeamFileStore,
  withFileMutationLock,
} from "../../domains/team-files/team-file-store.js";
import { ApiRequestError, writeJson } from "../http.js";
import { readFilenameHeader, readUploadBody } from "../upload-body.js";

export interface TeamFilesRoutesOptions {
  teamFileStore: TeamFileStore;
  fileParserLauncher?: FileParserLauncher;
}

export async function handleTeamFilesRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  options: TeamFilesRoutesOptions;
}): Promise<boolean> {
  const { req, res, url, options } = params;

  if (!url.pathname.startsWith("/create/team-files/")) {
    return false;
  }

  const prefix = "/create/team-files/";

  const remainder = url.pathname.slice(prefix.length);
  const segments = remainder.split("/").filter(Boolean);
  const [ownerSegment] = segments;
  if (ownerSegment === undefined) return false;

  const ownerId = decodeSafePathSegment(ownerSegment);
  if (!ownerId) {
    writeJson(res, 400, { error: "Invalid owner id" });
    return true;
  }

  const tail = segments.slice(1);

  if (tail.length === 1 && tail[0] === "files") {
    if (req.method === "GET") {
      const files = await projectDocumentReviews({ files: await options.teamFileStore.listFiles(ownerId), cacheDirs: [path.join(path.dirname(options.teamFileStore.inputsDir(ownerId)), 'document-review')] });
      writeJson(res, 200, { files });
      return true;
    }

    if (req.method === "POST") {
      const rawFilename = readFilenameHeader(req);
      if (!rawFilename) {
        writeJson(res, 400, {
          error: "Missing required header: x-filename",
        });
        return true;
      }
      const filename = decodeHeaderValue(rawFilename);
      const contents = await readUploadBody(req);
      const inputsDir = options.teamFileStore.inputsDir(ownerId);
      const uploaded = await withFileMutationLock(inputsDir, async () => {
        const saved = await options.teamFileStore.saveUploadedFile(ownerId, {
          filename,
          contents,
        });
        if (saved.status !== "saved") return saved;

        if (options.fileParserLauncher) {
          try {
            await options.fileParserLauncher.parseDirectory(inputsDir);
          } catch (error) {
            await options.teamFileStore.deleteFile(ownerId, saved.file.name);
            throw new ApiRequestError(
              `File uploaded, but parsing failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              502,
            );
          }
        }

        const refreshed = (await options.teamFileStore.listFiles(ownerId)).find(
          (file) => file.name === saved.file.name,
        );
        return { status: "saved" as const, file: refreshed ?? saved.file };
      });
      if (uploaded.status !== "saved") {
        writeUploadError(res, uploaded.status);
        return true;
      }
      writeJson(res, 201, uploaded.file);
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (tail.length === 2 && tail[0] === "files") {
    if (req.method === "DELETE") {
      const filenameSegment = tail[1];
      if (filenameSegment === undefined) {
        throw new Error("Team file DELETE route matched without a filename segment");
      }
      const filename = decodeSafePathSegment(filenameSegment);
      if (!filename) {
        writeJson(res, 400, { error: "Invalid filename" });
        return true;
      }
      const deletion = await options.teamFileStore.deleteFileIfUnused(
        ownerId,
        filename,
      );
      if (deletion === "locked") {
        writeJson(res, 409, {
          error: "This attachment has been used in chat and cannot be deleted",
        });
        return true;
      }
      if (deletion === "not_found") {
        writeJson(res, 404, { error: "File not found" });
        return true;
      }
      res.statusCode = 204;
      res.end();
      return true;
    }

    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  return false;
}

function writeUploadError(
  res: http.ServerResponse,
  status: Exclude<
    Awaited<ReturnType<TeamFileStore["saveUploadedFile"]>>["status"],
    "saved"
  >,
): void {
  switch (status) {
    case "duplicate_file":
      writeJson(res, 409, {
        error: "A document with that name is already uploaded. Delete it before uploading a replacement.",
      });
      return;
    case "locked_file":
      writeJson(res, 409, {
        error: "This attachment has been used in chat and cannot be replaced",
      });
      return;
    case "file_limit_reached":
      writeJson(res, 400, { error: "A maximum of 8 context documents is allowed" });
      return;
    case "unsupported_file":
      writeJson(res, 400, {
        // Composed from the same list the picker's `accept` and the store's allow-list read, so
        // this sentence cannot come to describe a different set than the one that was enforced.
        error: unsupportedUploadMessage("context document"),
      });
      return;
    case "invalid_filename":
      writeJson(res, 400, { error: "Invalid filename" });
      return;
  }
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
