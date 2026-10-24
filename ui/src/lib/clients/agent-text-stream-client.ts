/**
 * The renderer half of the display-only text stream.
 *
 * One reader for every chat surface. Which endpoint to read is the caller's
 * business; how to read it — cursor resume, loss handling, bounded reconnects
 * — is not, because those rules come from the frame contract rather than from
 * any one lane.
 *
 * `fetch` rather than `EventSource`: EventSource cannot set headers, cannot
 * resume from an explicit cursor, and would have to guess at the desktop's
 * token-prefixed base URL.
 */
import {
  isAgentTextStreamDelivery,
  type AgentTextStreamDelivery,
} from "@contracts/agent-text-stream";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();
const AGENT_TEXT_STREAM_MAX_RECONNECTS = 5;

/**
 * The server's end-of-channel marker.
 *
 * One reply's `final` says nothing about the others on the same channel, so it
 * cannot end the stream: a Team turn carries every speaker here, and stopping
 * at the first terminal strands the rest whenever a connection drops.
 */
const CHANNEL_COMPLETE_COMMENT = ": channel-complete";

/**
 * Subscribe to one channel's display-only text stream.
 *
 * Resumes with `?from=<lastCursor + 1>`. Only a framed delivery carries an SSE
 * id, so the `reset` prelude deliberately leaves the resume cursor where it
 * was. A malformed frame is skipped rather than ending the connection: this
 * channel is a preview and the durable answer is still coming, so one bad
 * frame must not cost the rest of it.
 */
export async function openAgentTextStreamAt(params: {
  /** Endpoint path, without the channel query. */
  path: string;
  channelId: string;
  signal: AbortSignal;
  onDelivery: (delivery: AgentTextStreamDelivery) => void;
  /**
   * Where to resume, for a caller that has already heard part of a channel.
   *
   * A subscription that starts again from zero replays every frame the reader
   * already showed, so a reply that had streamed one token renders it twice.
   */
  fromCursor?: number;
}): Promise<void> {
  let nextCursor = params.fromCursor ?? 0;
  let reconnects = 0;

  while (!params.signal.aborted) {
    // Reconnection is decided by the channel, not by one reply.
    //
    // A channel carries every speaker in a turn, so one reply's `final` says
    // nothing about the rest — treating it as the end strands every speaker
    // after the first whenever a connection drops. What does end the stream is
    // a connection that produced nothing: the channel is closed and drained,
    // or gone. Resuming from the cursor is exactly what the cursor is for, and
    // bounding the retries keeps a server that ends every connection
    // immediately from spinning the client.
    let channelComplete = false;
    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}${params.path}` +
          `?channelId=${encodeURIComponent(params.channelId)}&from=${nextCursor}`,
        { headers: { accept: "text/event-stream" }, signal: params.signal },
      );
    } catch (error) {
      if (params.signal.aborted) return;
      // Only a transport failure is worth reconnecting for.
      if (!(error instanceof TypeError)) throw error;
      // A failed attempt is a reconnect like any other. Leaving it uncounted
      // made the bounded-retry contract vacuous: a stream whose transport was
      // permanently down retried for as long as the tab stayed open.
      reconnects += 1;
      if (reconnects > AGENT_TEXT_STREAM_MAX_RECONNECTS) return;
      await agentTextStreamReconnectDelay(params.signal);
      continue;
    }

    // The turn is gone, or was never ours. Retrying cannot change that.
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(
        `Agent text stream failed with status ${response.status}`,
      );
    }
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!params.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        while (buffer.includes("\n\n")) {
          const separator = buffer.indexOf("\n\n");
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          if (block.startsWith(CHANNEL_COMPLETE_COMMENT)) {
            channelComplete = true;
            continue;
          }
          if (block.startsWith(":") || block.trim().length === 0) continue;

          let id: number | undefined;
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("id:")) {
              const parsedId = Number.parseInt(line.slice(3).trim(), 10);
              if (Number.isSafeInteger(parsedId) && parsedId >= 0) id = parsedId;
            }
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          if (!isAgentTextStreamDelivery(parsed)) continue;
          if (id !== undefined) nextCursor = id + 1;
          params.onDelivery(parsed);
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (params.signal.aborted || channelComplete) return;

    reconnects += 1;
    if (reconnects > AGENT_TEXT_STREAM_MAX_RECONNECTS) return;
    await agentTextStreamReconnectDelay(params.signal);
  }
}

function agentTextStreamReconnectDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // The listener is removed on both exits. `{ once: true }` only covers the
    // abort path; a delay that simply elapses would otherwise leave one
    // listener behind per retry, on a signal that lives as long as the stream.
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 250);
    signal.addEventListener("abort", onAbort);
  });
}
