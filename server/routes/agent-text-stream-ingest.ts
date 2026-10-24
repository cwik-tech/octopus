/**
 * Accept display frames from a run child.
 *
 * This is the only endpoint in the process authorized by a header rather than
 * by the token-in-path scheme, because the credential must never travel in a
 * URL: URLs reach access logs, `Referer` headers and error text, and this one
 * would be a working credential in all three.
 *
 * The authority it grants is one channel. It cannot read anything, it cannot
 * reach any other route, and it dies with its run. Nothing it publishes is
 * persisted — the durable record of a run is written by the run itself.
 */
import * as http from "node:http";

import { isAgentTextStreamInput } from "../../contracts/agent-text-stream.js";
import type { AgentTextStreamHub } from "../../domains/runtime/agent-text-stream-hub.js";
import type { AgentTextDeltaTokenRegistry } from "../../domains/runtime/agent-text-delta-tokens.js";
import { writeJson } from "../http.js";

/**
 * Frames are display-only and coalesced by the sender, so a batch is small.
 * The cap exists because this endpoint is reachable before the main
 * credential check and must not become a way to spend the parent's memory.
 */
const MAX_BATCH_BYTES = 256 * 1024;

/** How far past the cap a body is drained before the socket is cut instead. */
const DRAIN_CEILING_MULTIPLE = 16;

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

export async function handleAgentTextStreamIngestRoute(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  hub: AgentTextStreamHub;
  tokens: AgentTextDeltaTokenRegistry;
}): Promise<void> {
  const { req, res } = params;

  // The child is a local process. Anything else has no business here, and
  // saying so before looking at the credential keeps a remote caller from
  // learning whether one was valid.
  const peer = req.socket.remoteAddress ?? "";
  if (!LOOPBACK_ADDRESSES.has(peer)) {
    writeJson(res, 403, { error: "Forbidden" });
    return;
  }

  const grant = resolveGrant(req, params.tokens);
  if (!grant) {
    // Deliberately uniform with every other refusal below: the response never
    // distinguishes an unknown token from an expired one, and never repeats
    // any part of what was offered.
    writeJson(res, 403, { error: "Forbidden" });
    return;
  }

  let raw: string;
  try {
    raw = await readBoundedBody(req, MAX_BATCH_BYTES);
  } catch {
    writeJson(res, 413, { error: "Frame batch too large" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    writeJson(res, 400, { error: "Frame batch must be JSON" });
    return;
  }

  if (!isRecord(payload) || typeof payload.channelId !== "string") {
    writeJson(res, 400, { error: "Frame batch must name its channel" });
    return;
  }
  // The channel is what the token authorizes. A frame naming any other one is
  // refused whole rather than redirected, because a batch that reached the
  // wrong bubble would be somebody else's conversation.
  if (payload.channelId !== grant.channelId) {
    writeJson(res, 403, { error: "Forbidden" });
    return;
  }

  const frames = payload.frames;
  if (!Array.isArray(frames)) {
    writeJson(res, 400, { error: "Frame batch must carry frames" });
    return;
  }
  // Validated before anything is published, so a batch is all-or-nothing: a
  // partially applied batch would leave a bubble holding a suffix of an
  // answer with no way to tell.
  if (!frames.every(isAgentTextStreamInput)) {
    writeJson(res, 400, { error: "Frame batch contains an unusable frame" });
    return;
  }

  for (const frame of frames) params.hub.publish(grant.channelId, frame);
  writeJson(res, 202, { accepted: frames.length });
}

function resolveGrant(
  req: http.IncomingMessage,
  tokens: AgentTextDeltaTokenRegistry,
) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const [scheme, offered] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !offered) return undefined;
  return tokens.resolve(offered);
}

/**
 * Buffer at most `limit` bytes.
 *
 * Past the limit the body is discarded rather than kept, but the request is
 * still drained: cutting the socket mid-upload gives the child a transport
 * error instead of the refusal, and a sender that cannot tell "too large" from
 * "the parent went away" will keep retrying a batch that can never be
 * accepted. A second, far higher ceiling stops that from being unbounded.
 */
function readBoundedBody(
  req: http.IncomingMessage,
  limit: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        overLimit = true;
        chunks.length = 0;
        if (total > limit * DRAIN_CEILING_MULTIPLE) {
          reject(new Error("Frame batch too large"));
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (overLimit) {
        reject(new Error("Frame batch too large"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.once("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
