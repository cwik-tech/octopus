/**
 * The display-only text stream, served over SSE.
 *
 * One handler for every chat lane. The lane decides who owns a channel and
 * where the endpoint lives; everything below — validation, the ownership
 * refusal, the wait for a channel that does not exist yet, the pump, the
 * heartbeat and the teardown — is identical, and must stay identical, because
 * these are the rules `docs/adr/2026-08-22-Ephemeral-Agent-Text-Stream.md`
 * describes rather than anything specific to sessions.
 */
import * as http from "node:http";

import {
  startAgentTextStreamPump,
} from "../../domains/runtime/agent-text-stream-pump.js";
import {
  type AgentTextStreamHub,
  type AgentTextStreamWaitResult,
} from "../../domains/runtime/agent-text-stream-hub.js";
import { createSerializedSseWriter } from "../../domains/runtime/sse-serialized-writer.js";
import { isValidSessionId } from "../../contracts/sessions.js";
import type { AgentTextStreamDelivery } from "../../contracts/agent-text-stream.js";
import { createRequestAbort, writeJson } from "../http.js";

/** Written once when a channel is finished, so a clean end is unambiguous. */
export const CHANNEL_COMPLETE_COMMENT = ": channel-complete";

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface AgentTextStreamRequest {
  /** Absent when streaming is not configured for this process. */
  readonly hub: AgentTextStreamHub | undefined;
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly url: URL;
  /**
   * The identity the channel must have been opened under.
   *
   * A channel id alone must never grant access: serving one through another
   * owner's URL would leak that conversation's live text. Lanes use disjoint
   * owner values, so a session channel cannot be read through a Create
   * endpoint either.
   */
  readonly ownerId: string;
  readonly waitMs?: number;
  readonly heartbeatMs?: number;
}

/**
 * Serve `?channelId=<uuid>&from=<cursor>` as an event stream.
 *
 * Returns `true` once the request has been answered, in the route-handler
 * convention this file's callers already use.
 */
export async function handleAgentTextStreamRequest(
  request: AgentTextStreamRequest,
): Promise<boolean> {
  const { req, res, url } = request;
  const hub = request.hub;
  if (!hub) {
    writeJson(res, 404, { error: "Agent text streaming is unavailable" });
    return true;
  }

  const channelId = url.searchParams.get("channelId") ?? "";
  if (!isValidSessionId(channelId)) {
    writeJson(res, 400, { error: "channelId must be a UUID" });
    return true;
  }

  // External query input. `parseInt(...) || 0` would silently turn "abc", "-5"
  // and "1e9" into a valid-looking cursor, so anything that is not a
  // nonnegative safe integer is rejected instead of coerced.
  const rawFrom = url.searchParams.get("from");
  const fromCursor = rawFrom === null ? 0 : Number(rawFrom);
  if (
    rawFrom !== null &&
    (rawFrom.trim() === "" ||
      !Number.isSafeInteger(fromCursor) ||
      fromCursor < 0)
  ) {
    writeJson(res, 400, { error: "from must be a nonnegative integer" });
    return true;
  }

  // The client mints the channel id, subscribes, and only then sends the turn,
  // so a stream legitimately arrives before its channel exists. Wait for the
  // matching request rather than making the client race. The wait creates
  // nothing: only the turn may open its own channel.
  const channelOwner = hub.ownerOf(channelId);
  if (channelOwner !== undefined && channelOwner !== request.ownerId) {
    // The owner is known and it is somebody else. Nothing can change that, so
    // waiting would only hold one of a bounded number of slots and delay a
    // certain answer. Reported as "not found" like every other refusal, so an
    // unguessable id is never confirmed to exist.
    writeJson(res, 404, { error: "Stream channel not found" });
    return true;
  }
  if (channelOwner !== request.ownerId) {
    // `req.close` alone is not the client-disconnect boundary for a long-lived
    // response: `createRequestAbort` also watches `req.aborted` and a premature
    // `res.close`, which is what actually fires when a browser goes away
    // mid-stream. A waiter that outlives its connection holds a bounded slot
    // for nothing.
    const waitAbort = createRequestAbort(req, res);
    let waited: AgentTextStreamWaitResult;
    try {
      waited = await hub.waitForChannel(channelId, request.ownerId, {
        timeoutMs: request.waitMs ?? DEFAULT_WAIT_MS,
        signal: waitAbort.signal,
      });
    } finally {
      waitAbort.dispose();
    }
    if (waited !== "opened") {
      if (!res.writableEnded && !res.destroyed) {
        writeJson(res, 404, { error: "Stream channel not found" });
      }
      return true;
    }
  }

  if (!hub.read(channelId, fromCursor)) {
    writeJson(res, 404, { error: "Stream channel not found" });
    return true;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  // Every byte this connection emits goes through one writer. Backpressure
  // belongs to the socket, not to any single producer, so the prelude, the
  // keep-alives and the pump's frames must share one queue or they can
  // interleave mid-drain.
  const writer = createSerializedSseWriter(async (payload) => {
    await writeSsePayload(res, payload);
  });
  void writer.write(": connected\n\n").catch(() => closeStream());

  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  const closeStream = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    pump.stop();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  res.once("error", closeStream);
  res.once("close", closeStream);
  req.once("close", closeStream);

  // The pump owns delivery: one outstanding write at a time. The hub never
  // writes to a socket, because `writeSsePayload` resolves on `drain` and
  // awaiting that inside `publish` would couple generation to the renderer.
  const pump = startAgentTextStreamPump({
    hub,
    channelId,
    fromCursor,
    write: async (delivery, id) => {
      await writer.write(formatAgentTextDelivery(delivery, id));
    },
  });
  void pump.done.then(() => {
    // A closed socket alone is ambiguous: it could be a finished channel or a
    // dropped connection, and a client that guesses wrong either strands the
    // speakers after the first or reconnects forever. Saying it explicitly
    // costs one comment frame, which every SSE parser already skips.
    void writer
      .write(`${CHANNEL_COMPLETE_COMMENT}\n\n`)
      .catch(() => undefined)
      .finally(closeStream);
  });

  heartbeat = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) return;
    // Skip rather than queue while anything is in flight. Ordering is already
    // guaranteed by the shared writer; skipping keeps a backpressured socket
    // from accumulating keep-alives it cannot send, and a write in flight is
    // itself proof of life.
    if (!writer.idle) return;
    void writer
      .write(`: keep-alive ${new Date().toISOString()}\n\n`)
      .catch(() => closeStream());
  }, request.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref?.();

  return true;
}

function formatAgentTextDelivery(
  delivery: AgentTextStreamDelivery,
  id: number | undefined,
): string {
  // `id` is omitted for the `reset` prelude. An event with no `id:` leaves the
  // client's last-event-id untouched, so SSE ids stay strictly monotonic even
  // though the reset precedes frames whose cursors are higher than the range it
  // warns about.
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}event: ${delivery.type}\ndata: ${JSON.stringify(delivery)}\n\n`;
}

/**
 * Write one payload, resolving only once the socket has accepted it. The single
 * point where bytes reach the response, so the serializer above is the only
 * thing that can order them.
 */
function writeSsePayload(
  res: http.ServerResponse,
  payload: string,
): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    return Promise.reject(new Error("Agent text stream is closed"));
  }
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
      reject(new Error("Agent text stream closed before draining"));
    };
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
  });
}
