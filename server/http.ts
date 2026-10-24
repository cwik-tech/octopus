import { providerAbortReason } from '../contracts/provider-abort.js';
import type * as http from "node:http";
import type * as z from "zod/v4";

import type { RunStartRequest } from "../contracts/runs.js";
import { runStartRequestSchema } from "../contracts/schemas/run-requests.js";
import { ApiRequestError } from "../core/http-json-body.js";
import {
  ServiceError,
  statusCodeForServiceError,
} from "../services/service-errors.js";

export {
  ApiRequestError,
  readJsonBody,
} from "../core/http-json-body.js";

export function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/**
 * A signal that aborts when the client goes away.
 *
 * Exported because a long-lived response has more than one disconnect
 * boundary, and every route that holds one open needs the same set. `res`
 * closing only counts as a disconnect while the response is unfinished;
 * `req` closing on its own does not, because that also happens on every
 * successfully completed request.
 */
export function createRequestAbort(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(providerAbortReason('request-disconnected'));
  const abortOnPrematureClose = () => {
    if (!res.writableFinished) abort();
  };
  req.once("aborted", abort);
  res.once("close", abortOnPrematureClose);
  return {
    signal: controller.signal,
    dispose() {
      req.off("aborted", abort);
      res.off("close", abortOnPrematureClose);
    },
  };
}

export function writeServiceError(
  res: http.ServerResponse,
  error: ServiceError,
): void {
  const payload =
    error.details && typeof error.details === "object"
      ? { error: error.message, ...(error.details as Record<string, unknown>) }
      : { error: error.message };
  writeJson(res, statusCodeForServiceError(error), payload);
}

export function parseApiRequest<T>(
  schema: z.ZodType<T>,
  payload: unknown,
): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ApiRequestError(
      result.error.issues[0]?.message ?? "Request body is invalid",
      400,
    );
  }
  return result.data;
}

export function parseRunStartRequest(payload: unknown): RunStartRequest {
  return parseApiRequest(runStartRequestSchema, payload);
}
