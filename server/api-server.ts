import { whenDefined } from "../core/optional-properties.js"
import { createHash, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as path from "node:path";
import { URL, fileURLToPath } from "node:url";

import { initProviders } from "../providers/index.js";
import { loadDotEnv } from "../core/env-loader.js";
import {
  SourceFileParserLauncher,
} from "../core/file-parser-launcher.js";
import { coordinateFileParserLauncher } from "../core/file-parse-coordinator.js";
import { PiRunLauncher } from "../domains/run/run-launcher.js";
import { FileSystemRunStore } from "../domains/run/run-store.js";
import { ServiceError } from "../services/service-errors.js";
import { TaskQueueError } from "../services/task-queue.js";
import { FileSystemSessionStore } from "../domains/sessions/session-store.js";
import { TeamFileStore } from "../domains/team-files/team-file-store.js";
import type { ApiServerOptions, StartedApiServer } from "./api-types.js";
import { buildServices } from "./composition.js";
import {
  ApiRequestError,
  writeJson,
  writeServiceError,
} from "./http.js";
import {
  createApiRouteTable,
  type ApiRouteServices,
} from "./route-table.js";
import { dispatchRoutes, type RouteCredentialScope } from "./routing.js";
import { parseResourceArchitectFeedbackConfig } from '../domains/resource-architect/resource-architect-feedback-config.js';

/**
 * How long a graceful shutdown gives in-flight work to finish (AC18), when
 * `ApiServerOptions.shutdownDeadlineMs` does not say.
 *
 * Deliberately its own constant rather than an alias of the
 * assignment-release drain: they bound different things, and aliasing would
 * make one change silently with the other.
 *
 * **Provisional operational policy, not a measured value.** It preserves the
 * bound operators already live with. Real in-flight settle times still need to
 * be measured to calibrate it.
 *
 * It bounds *draining*, not total shutdown time. Once the drain deadline
 * passes, finalization is strict — the journal does not close until every
 * unsettled attempt's decision append has succeeded — so a slow journal can
 * extend a shutdown past this value. That is the correct trade: closing on
 * time with no decision in the stream is the defect AC18 removes.
 */
const SHUTDOWN_DEADLINE_MS = 5_000;

// Load .env from repo root before any code reads process.env. The CLI entry
// at team-runtime/index.ts already does this; api-server.ts is a separate
// entrypoint (npm run api → tsx server/api-server.ts) and needs its own call.
loadDotEnv();
initProviders();

export type { ApiServerOptions, StartedApiServer } from "./api-types.js";

export const DEFAULT_EVENT_POLL_INTERVAL_MS = 250;

const AUTHENTICATED_API_PATH_PREFIX = "_pipeline";

type ApiAuthScope = RouteCredentialScope;

function tokensMatch(providedToken: string, expectedToken: string): boolean {
  const providedDigest = createHash("sha256")
    .update(providedToken, "utf8")
    .digest();
  const expectedDigest = createHash("sha256")
    .update(expectedToken, "utf8")
    .digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function authenticateAndStripApiPath(
  url: URL,
  apiToken: string,
  brokerToken?: string,
): ApiAuthScope | null {
  const pathSegments = url.pathname.split("/");
  if (pathSegments[1] !== AUTHENTICATED_API_PATH_PREFIX || !pathSegments[2]) {
    return null;
  }

  let providedToken: string;
  try {
    providedToken = decodeURIComponent(pathSegments[2]);
  } catch {
    return null;
  }

  let scope: ApiAuthScope;
  if (tokensMatch(providedToken, apiToken)) {
    scope = "full";
  } else if (
    brokerToken !== undefined &&
    tokensMatch(providedToken, brokerToken)
  ) {
    scope = "broker";
  } else {
    return null;
  }

  const routedPath = pathSegments.slice(3).join("/");
  url.pathname = routedPath ? `/${routedPath}` : "/";
  return scope;
}

function authenticatedApiUrl(baseUrl: string, apiToken?: string): string {
  if (apiToken === undefined) return baseUrl;
  return `${baseUrl}/${AUTHENTICATED_API_PATH_PREFIX}/${encodeURIComponent(apiToken)}`;
}

function approvedLoopbackOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== "http:" ||
      origin.username ||
      origin.password ||
      !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
    ) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function applyLoopbackCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const origin = approvedLoopbackOrigin(
    typeof req.headers.origin === "string" ? req.headers.origin : undefined,
  );
  if (!origin) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader(
    "access-control-allow-methods",
    "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "access-control-allow-headers",
    "content-type, x-filename",
  );
  res.setHeader("access-control-max-age", "600");
  res.setHeader("vary", "Origin");
  return true;
}

export async function startApiServer(
  options: ApiServerOptions,
): Promise<StartedApiServer> {
  validateServerOptions(options);
  const resourceArchitectFeedback = parseResourceArchitectFeedbackConfig(process.env);
  const runtimeOptions = options.fileParserLauncher
    ? {
        ...options,
        fileParserLauncher: coordinateFileParserLauncher(
          options.fileParserLauncher,
        ),
      }
    : options;

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const eventPollIntervalMs =
    options.eventPollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS;
  const composition = await buildServices(runtimeOptions);
  await composition.start();

  const routeServices: ApiRouteServices = {
    options: runtimeOptions,
    composition: composition.services,
    eventPollIntervalMs,
    resourceArchitectReviewEnabled: resourceArchitectFeedback.reviewEnabled,
  };
  const routes = createApiRouteTable(routeServices);

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        writeJson(res, 400, { error: "Malformed request" });
        return;
      }

      const url = new URL(
        req.url,
        `http://${req.headers.host ?? `${formatHostForUrl(host)}:${port}`}`,
      );
      const context = { req, res, url, services: routeServices };

      if (
        await dispatchRoutes({
          routes,
          stage: "pre-auth-capability",
          context,
        })
      ) {
        return;
      }

      const hasApprovedCorsOrigin = applyLoopbackCorsHeaders(req, res);
      if (options.apiToken !== undefined) {
        res.setHeader("cache-control", "no-store");
      }

      let authScope: ApiAuthScope | null = null;
      if (options.apiToken !== undefined) {
        authScope = authenticateAndStripApiPath(
          url,
          options.apiToken,
          options.brokerToken,
        );
        if (authScope === null) {
          writeJson(res, 401, { error: "Unauthorized" });
          return;
        }
      }

      if (req.method === "OPTIONS") {
        if (!hasApprovedCorsOrigin) {
          writeJson(res, 403, { error: "Origin not allowed" });
          return;
        }
        res.statusCode = 204;
        res.end();
        return;
      }

      // State-changing requests must not be drivable from an arbitrary web
      // origin (tokenless dev mode has no credential to stop them).
      if (
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        req.headers.origin !== undefined &&
        !hasApprovedCorsOrigin
      ) {
        writeJson(res, 403, { error: "Origin not allowed" });
        return;
      }

      // The broker credential authorizes the credential-broker route only.
      if (
        authScope === "broker" &&
        !(
          req.method === "POST" &&
          url.pathname === "/settings/provider-execute"
        )
      ) {
        writeJson(res, 403, { error: "Forbidden" });
        return;
      }

      applyCompatibilityPathAliases(url);

      // Health remains a transport-shell concern so it can report the HTTP
      // process without coupling to a feature route.
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (
        await dispatchRoutes({
          routes,
          stage: "api",
          // The resolved credential reaches the route only here, after
          // authentication has decided it. A route that writes durable state
          // needs to know which credential admitted the caller, and on a
          // tokenless server there is none to know.
          context: {
            ...context,
            ...(authScope === null ? {} : { credentialScope: authScope }),
          },
        })
      ) {
        return;
      }

      writeJson(res, 404, { error: "Not found" });
    } catch (error) {
      translateRequestError(res, error);
    }
  });

  // Built before anything is bound. It validates its own window, and a
  // rejected configuration must fail while there is still no listener to
  // leak: throwing after `listen` succeeded would abandon a bound socket
  // with no handle for the caller to close it by.
  //
  // The composition is already started by this point, so a failure here is
  // cleaned up the same way a failed `listen` is — the caller gets no handle,
  // and must not be left owning services it cannot reach.
  let close: () => Promise<void>;
  try {
    close = createGracefulShutdown({
      server,
      composition,
      ...(options.shutdownDeadlineMs === undefined
        ? {}
        : { shutdownDeadlineMs: options.shutdownDeadlineMs }),
    });
  } catch (error) {
    await composition.dispose().catch(() => undefined);
    throw error;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  } catch (error) {
    await composition.dispose().catch(() => undefined);
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    const error = new Error("Failed to resolve API server address");
    await closeServerAndComposition(server, composition).catch(
      () => undefined,
    );
    throw error;
  }

  const baseUrl = `http://${formatHostForUrl(host)}:${address.port}`;
  const publicUrl = authenticatedApiUrl(baseUrl, options.apiToken);
  const brokerUrl =
    options.brokerToken !== undefined
      ? `${authenticatedApiUrl(baseUrl, options.brokerToken)}/settings/provider-execute`
      : undefined;
  try {
    await composition.activateAfterListen({
      host,
      port: address.port,
      baseUrl,
      publicUrl,
      ...whenDefined(brokerUrl, (definedValue) => ({ brokerUrl: definedValue })),
    });
  } catch (error) {
    await closeServerAndComposition(server, composition).catch(
      () => undefined,
    );
    throw error;
  }

  return {
    host,
    port: address.port,
    url: publicUrl,
    close,
  };
}

function validateServerOptions(options: ApiServerOptions): void {
  if (
    options.apiToken !== undefined &&
    options.apiToken.trim().length === 0
  ) {
    throw new Error("apiToken must not be empty when configured");
  }
  if (
    options.brokerToken !== undefined &&
    options.brokerToken.trim().length === 0
  ) {
    throw new Error("brokerToken must not be empty when configured");
  }
  if (
    options.brokerToken !== undefined &&
    options.apiToken === undefined
  ) {
    throw new Error("brokerToken requires apiToken");
  }
  if (
    options.brokerToken !== undefined &&
    options.apiToken !== undefined &&
    options.brokerToken === options.apiToken
  ) {
    throw new Error("brokerToken must differ from apiToken");
  }

  if (options.voiceControl !== undefined) {
    const mcpToken = options.voiceControl.mcpToken;
    if (mcpToken.trim().length === 0) {
      throw new Error("voiceControl.mcpToken must not be empty");
    }
    if (mcpToken === options.apiToken || mcpToken === options.brokerToken) {
      throw new Error("voiceControl.mcpToken must differ from the other tokens");
    }
  }

  validateShutdownDeadlineMs(options.shutdownDeadlineMs);

  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(
      `API host must be loopback-only (127.0.0.1, localhost, or ::1), received ${host}`,
    );
  }
}

function applyCompatibilityPathAliases(url: URL): void {
  // Vite already strips /api in development. Keep only the historic Create
  // compatibility path; do not turn this into a broad /api/* rewrite.
  if (url.pathname.startsWith("/api/create/")) {
    url.pathname = url.pathname.replace(/^\/api/, "");
  }
}

function translateRequestError(
  res: http.ServerResponse,
  error: unknown,
): void {
  if (error instanceof ApiRequestError) {
    writeJson(res, error.statusCode, { error: error.message });
    return;
  }
  if (error instanceof ServiceError) {
    writeServiceError(res, error);
    return;
  }
  if (error instanceof TaskQueueError) {
    const retryable =
      error.code === "task_admission_recovering" ||
      error.code === "task_queue_closed";
    if (error.code === "task_admission_recovering") {
      res.setHeader("retry-after", "1");
    }
    writeJson(
      res,
      retryable
        ? 503
        : error.code === "task_admission_conflict"
          ? 409
          : 500,
      { error: error.message, code: error.code, retryable },
    );
    return;
  }

  writeJson(res, 500, {
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * A shutdown window must be a positive, finite number of milliseconds.
 *
 * Rejected rather than coerced. The window is the only thing standing between
 * a drain and a process that never exits, so silently substituting a default
 * for a bad value would hide the misconfiguration until it mattered. An
 * omitted value is not a bad one — it means the default applies.
 */
function validateShutdownDeadlineMs(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `shutdownDeadlineMs must be a finite, positive number of milliseconds; received ${String(value)}`,
    );
  }
}

/** What graceful shutdown needs from the composition it is closing (AC18). */
export interface GracefulShutdownComposition {
  /** Bars new capability dispatch without tearing anything down. */
  beginShutdown(): void;
  dispose(options?: { readonly deadlineMs?: number }): Promise<void>;
}

/**
 * The graceful shutdown a process calls, with the state it has to remember.
 *
 * Concurrent callers share the attempt in flight and a shutdown that already
 * succeeded is never repeated, because closing an already-closed resource is
 * its own hazard. A *failed* attempt is deliberately not remembered: the
 * fault may be transient — the same recoverable-versus-integrity distinction
 * AC6 drew for the journal — and a process that could only ever try once
 * would be stuck with its first bad outcome.
 *
 * The stored promise is the handled one, so the memo is already clear by the
 * time any caller sees the failure and nothing is left floating.
 */
export function createGracefulShutdown(input: {
  readonly server: http.Server;
  readonly composition: GracefulShutdownComposition;
  readonly shutdownDeadlineMs?: number;
}): () => Promise<void> {
  // Its own entry point, so it validates its own input rather than trusting
  // the checks `startApiServer` runs over `ApiServerOptions`.
  validateShutdownDeadlineMs(input.shutdownDeadlineMs);
  let inFlight: Promise<void> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const attempt = closeServerAndComposition(
      input.server,
      input.composition,
      input.shutdownDeadlineMs,
    ).catch((error: unknown) => {
      inFlight = undefined;
      throw error;
    });
    inFlight = attempt;
    return attempt;
  };
}

/**
 * Graceful shutdown, in order: stop accepting, drain, destroy what outlived
 * the drain, then dispose what those handlers depended on (AC18).
 *
 * This used to run the HTTP teardown and the composition dispose
 * concurrently, and the HTTP side destroyed every connection immediately. A
 * request that was mid-handler lost its socket, and the services under it
 * were disposed while it was still allowed to finish — so work that had
 * already changed state returned nothing to its caller.
 *
 * The deadline is computed once here, at shutdown start, and the same
 * absolute value bounds both the drain and the disposal underneath it. A
 * fresh window at each step would let a shutdown bounded at N ms spend a
 * multiple of it.
 */
async function closeServerAndComposition(
  server: http.Server,
  composition: GracefulShutdownComposition,
  shutdownDeadlineMs: number = SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  const deadline = Date.now() + shutdownDeadlineMs;

  // Stop accepting, on both doors into the process at once: the listener
  // stops taking new connections, and `beginShutdown` bars the second entry
  // path — out-of-band MCP and worker dispatch — at the same moment.
  //
  // A retry finds the listener already down. Calling `close` again would
  // report `ERR_SERVER_NOT_RUNNING` and mask the disposal that is the whole
  // reason for retrying, so an already-closed listener counts as closed.
  const listenerClosed = server.listening
    ? new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
    : Promise.resolve();
  composition.beginShutdown();
  server.closeIdleConnections();

  // Drain: in-flight handlers finish within the shared deadline. The outcome
  // is captured rather than awaited directly, so a listener that fails to
  // close cannot strand the composition — cleanup runs either way and the
  // first error is reported at the end.
  const timer = deadlineTimer(deadline);
  const drainResult = await Promise.race([
    listenerClosed.then(
      () => undefined,
      (error: unknown) => error,
    ),
    timer.reached.then(() => undefined),
  ]);
  timer.cancel();

  // Past the deadline the drain has failed, so shutdown takes the remaining
  // connections itself — and it does that before disposing what the handlers
  // on them were built on. Ending a socket does not stop handler code that is
  // already running; nothing here can. What this fixes is the order of the
  // two forced teardowns: the transport goes first, so the process is not
  // disposing services while their transport is still live and accepting
  // writes.
  server.closeAllConnections();

  // Second, and given what remains of the same window rather than a fresh
  // one. Handler code that was already running may still be running here —
  // shutdown cannot stop it — so this is an ordering guarantee about the two
  // teardowns, not a promise that nothing will touch these services again.
  const compositionResult = await Promise.allSettled([
    composition.dispose({ deadlineMs: deadline }),
  ]);
  const serverResult = await Promise.allSettled([listenerClosed]);

  if (drainResult !== undefined) throw drainResult;
  if (serverResult[0]?.status === "rejected") throw serverResult[0].reason;
  if (compositionResult[0]?.status === "rejected") {
    throw compositionResult[0].reason;
  }
}

function deadlineTimer(deadlineMs: number): {
  readonly reached: Promise<void>;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), Math.max(0, deadlineMs - Date.now()));
    timer.unref?.();
  });
  return {
    reached,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export async function startDefaultApiServer(params: {
  workspacePath: string;
  host?: string;
  port?: number;
  eventPollIntervalMs?: number;
  resourceLibraryRootPath?: string;
}): Promise<StartedApiServer> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..");
  const defaultWorkflowsRegistry = path.resolve(
    repoRoot,
    "workflows",
    "registry.yaml",
  );

  return startApiServer({
    store: new FileSystemRunStore(params.workspacePath),
    launcher: new PiRunLauncher(),
    fileParserLauncher: new SourceFileParserLauncher(repoRoot),
    sessionStore: new FileSystemSessionStore(params.workspacePath),
    teamFileStore: new TeamFileStore(params.workspacePath),
    workflowsRegistryPath: defaultWorkflowsRegistry,
    repoRootPath: repoRoot,
    resourceLibraryRootPath:
      params.resourceLibraryRootPath ?? path.join(params.workspacePath, "resource-library"),
    ...whenDefined(params.host, (definedValue) => ({ host: definedValue })),
    ...whenDefined(params.port, (definedValue) => ({ port: definedValue })),
    ...whenDefined(params.eventPollIntervalMs, (definedValue) => ({ eventPollIntervalMs: definedValue })),
    workspacePath: params.workspacePath,
    recoverInterruptedTasks: true,
  });
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  return path.resolve(entryPath) === fileURLToPath(import.meta.url);
}

async function runCli(): Promise<void> {
  const workspacePath =
    process.env.API_WORKSPACE_PATH || path.resolve(process.cwd(), "workspace");
  const host = process.env.API_HOST || "127.0.0.1";
  const port = process.env.API_PORT
    ? Number.parseInt(process.env.API_PORT, 10)
    : 3001;
  const eventPollIntervalMs = process.env.API_EVENT_POLL_MS
    ? Number.parseInt(process.env.API_EVENT_POLL_MS, 10)
    : 250;

  const server = await startDefaultApiServer({
    workspacePath,
    host,
    port,
    eventPollIntervalMs,
  });

  console.log(`Team Runtime API listening on ${server.url}`);
  console.log(`Workspace path: ${workspacePath}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

if (isDirectExecution()) {
  void runCli().catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : String(error),
    );
    process.exit(1);
  });
}
