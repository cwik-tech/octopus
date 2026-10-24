import type * as http from "node:http";
import type { ReadStream } from "node:fs";
import { URL } from "node:url";

import { createExcelWorkbookPreview } from "../../domains/excel-generation/excel-preview.js";
import { decodeSafePathSegment } from "../../core/path-safety.js";
import type { RunLauncher } from "../../domains/run/run-launcher.js";
import type { RunStore } from "../../domains/run/run-store.js";
import { loadRunTeamFlow } from "../../workflows/team-flow.js";
import {
  ApiRequestError,
  parseRunStartRequest,
  readJsonBody,
  writeJson,
} from "../http.js";

export interface RunRoutesOptions {
  store: RunStore;
  launcher: RunLauncher;
  workspacePath?: string;
  eventPollIntervalMs: number;
  hasSessionTaskRuntime: boolean;
}

export async function handleRunCollectionRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  options: RunRoutesOptions;
}): Promise<boolean> {
  const { req, res, url, options } = params;

  if (url.pathname === "/runs") {
    if (req.method === "GET") {
      const runs = await options.store.listRuns();
      writeJson(res, 200, { runs });
      return true;
    }

    if (req.method === "POST") {
      if (options.hasSessionTaskRuntime) {
        writeJson(res, 409, {
          error:
            "Top-level runs require durable session task admission; use the session Apply endpoint.",
          code: "task_admission_required",
          retryable: false,
        });
        return true;
      }
      const body = parseRunStartRequest(await readJsonBody(req));
      const launched = await options.launcher.startRun(body);
      writeJson(res, 202, launched);
      return true;
    }

    return false;
  }

  return false;
}

export async function handleRunDetailRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  options: RunRoutesOptions;
}): Promise<boolean> {
  const { req, res, url, options } = params;
  const runRoute = decodeRunRoute(url);
  if (!runRoute) return false;

  if (req.method === "GET" && runRoute.tail.length === 0) {
    const run = await options.store.getRun(runRoute.runId);
    if (!run) {
      writeJson(res, 404, { error: "Run not found" });
      return true;
    }
    writeJson(res, 200, run);
    return true;
  }

  if (
    req.method === "GET" &&
    runRoute.tail.length === 1 &&
    runRoute.tail[0] === "diagnostics"
  ) {
    const diagnostics = await options.store.getRunDiagnostics(runRoute.runId);
    if (!diagnostics) {
      writeJson(res, 404, { error: "Run not found" });
      return true;
    }

    res.setHeader("cache-control", "no-store");
    writeJson(res, 200, diagnostics);
    return true;
  }

  if (
    req.method === "GET" &&
    runRoute.tail.length === 1 &&
    runRoute.tail[0] === "flow"
  ) {
    if (!options.workspacePath) {
      writeJson(res, 500, {
        error: "Run flow is unavailable without a configured workspace path",
      });
      return true;
    }

    const flow = await loadRunTeamFlow(
      options.store,
      options.workspacePath,
      runRoute.runId,
    );
    if (!flow) {
      writeJson(res, 404, { error: "Run flow not found" });
      return true;
    }

    writeJson(res, 200, flow);
    return true;
  }

  if (
    req.method === "GET" &&
    runRoute.tail.length === 1 &&
    runRoute.tail[0] === "events"
  ) {
    const run = await options.store.getRun(runRoute.runId);
    if (!run) {
      writeJson(res, 404, { error: "Run not found" });
      return true;
    }

    if (url.searchParams.get("snapshot") === "1") {
      const events = await options.store.listRunEvents(runRoute.runId);
      writeJson(res, 200, { events });
      return true;
    }

    const fromIndex =
      Number.parseInt(url.searchParams.get("from") ?? "", 10) || 0;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    let stopped = false;
    let stop = () => {};
    const closeStream = () => {
      if (stopped) return;
      stopped = true;
      stop();
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    res.once("error", closeStream);
    res.once("close", closeStream);
    req.once("close", closeStream);
    res.write(": connected\n\n");

    stop = options.store.tailRunEvents(
      runRoute.runId,
      async (event, index) => {
        try {
          await writeSseEvent(res, event.type, event, index);
        } catch {
          closeStream();
        }
      },
      {
        fromIndex,
        pollIntervalMs: options.eventPollIntervalMs,
      },
    );
    return true;
  }

  if (
    req.method === "GET" &&
    runRoute.tail[0] === "assignments" &&
    runRoute.tail.length > 1
  ) {
    const artifactPath = runRoute.tail.slice(1).join("/");
    if (/\.(?:mp4|webm)$/i.test(artifactPath) && options.store.openArtifactStream) {
      const openStream = (range?: { start: number; end: number }) =>
        options.store.openArtifactStream?.(
          runRoute.runId,
          artifactPath,
          range ? { range } : undefined,
        );
      const artifact = await openStream();
      if (!artifact) {
        writeJson(res, 404, { error: "Artifact not found" });
        return true;
      }
      const totalBytes = artifact.contentLength;
      const etag = artifact.etag;
      res.setHeader("accept-ranges", "bytes");
      if (etag) res.setHeader("etag", etag);
      if (
        etag &&
        typeof req.headers["if-none-match"] === "string" &&
        req.headers["if-none-match"] === etag
      ) {
        discardArtifactStream(artifact.stream);
        res.statusCode = 304;
        res.end();
        return true;
      }
      const byteRange = parseByteRangeHeader(req.headers.range, totalBytes);
      if (byteRange === "unsatisfiable") {
        discardArtifactStream(artifact.stream);
        res.statusCode = 416;
        res.setHeader("content-range", `bytes */${totalBytes}`);
        res.end();
        return true;
      }
      let stream = artifact.stream;
      let responseLength = artifact.contentLength;
      if (byteRange) {
        discardArtifactStream(artifact.stream);
        const ranged = await openStream(byteRange);
        if (!ranged) {
          writeJson(res, 404, { error: "Artifact not found" });
          return true;
        }
        stream = ranged.stream;
        responseLength = ranged.contentLength;
        res.statusCode = 206;
        res.setHeader("content-range", `bytes ${byteRange.start}-${byteRange.end}/${totalBytes}`);
      } else {
        res.statusCode = 200;
      }
      res.setHeader("content-type", artifact.contentType);
      res.setHeader("content-length", String(responseLength));
      res.setHeader("content-disposition", artifact.contentDisposition ?? "attachment");
      res.setHeader("x-content-type-options", "nosniff");
      stream.once("error", () => res.destroy());
      // A client that abandons a multi-gigabyte download closes the response
      // while the file read stream is still alive — destroy it so the
      // descriptor does not linger until garbage collection.
      res.once("close", () => {
        if (!res.writableEnded) stream.destroy();
      });
      stream.pipe(res);
      return true;
    }
    const artifact = await options.store.readArtifact(
      runRoute.runId,
      artifactPath,
    );
    if (!artifact) {
      writeJson(res, 404, { error: "Artifact not found" });
      return true;
    }
    if (url.searchParams.get("preview") === "workbook") {
      if (
        artifact.contentType !==
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        typeof artifact.content === "string"
      ) {
        writeJson(res, 400, {
          error: "Workbook preview is available only for XLSX artifacts",
        });
        return true;
      }
      try {
        const preview = await createExcelWorkbookPreview(artifact.content);
        writeJson(res, 200, preview);
      } catch (error) {
        writeJson(res, 422, {
          error:
            error instanceof Error
              ? `Workbook preview failed: ${error.message}`
              : "Workbook preview failed",
        });
      }
      return true;
    }
    res.statusCode = 200;
    res.setHeader("content-type", artifact.contentType);
    res.setHeader("x-content-type-options", "nosniff");
    if (artifact.contentDisposition) {
      res.setHeader("content-disposition", artifact.contentDisposition);
    }
    res.end(artifact.content);
    return true;
  }

  writeJson(res, 404, { error: "Not found" });
  return true;
}

function decodeRunRoute(
  url: URL,
): { runId: string; tail: string[] } | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "runs" || !parts[1]) return null;
  const runId = decodeSafePathSegment(parts[1]);
  const tail = parts.slice(2).map((part) => decodeSafePathSegment(part));
  if (!runId || tail.some((part) => !part)) {
    throw new ApiRequestError("Invalid run path", 400);
  }
  return {
    runId,
    tail: tail as string[],
  };
}

function discardArtifactStream(stream: ReadStream): void {
  // createReadStream opens lazily. A discarded metadata stream may therefore
  // report an open error after the response and its temporary fixture close.
  stream.once("error", () => undefined);
  stream.destroy();
}

/**
 * Parse a single-range `Range: bytes=` header against a known total length.
 * Returns `null` when the header is absent or syntactically ignorable (serve
 * the full body), `"unsatisfiable"` for a well-formed range that starts past
 * the end of the file, or the clamped inclusive byte bounds.
 */
function parseByteRangeHeader(
  header: string | undefined,
  totalBytes: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    const start = Math.max(0, totalBytes - suffixLength);
    return start >= totalBytes
      ? "unsatisfiable"
      : { start, end: totalBytes - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= totalBytes) return "unsatisfiable";
  const end = match[2] === ""
    ? totalBytes - 1
    : Math.min(Number(match[2]), totalBytes - 1);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

function writeSseEvent(
  res: http.ServerResponse,
  eventName: string,
  data: unknown,
  id: number,
): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    return Promise.reject(new Error("SSE response is closed"));
  }
  const payload =
    `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  if (res.write(payload)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("error", onError);
      res.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("SSE response closed before draining"));
    };
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
  });
}
