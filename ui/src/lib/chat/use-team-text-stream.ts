/**
 * Subscribe to a Team run's display-only text stream.
 *
 * The channel is discovered from the run's own events rather than requested,
 * so this opens only once the run has announced one — and closes when the run
 * moves to a different channel or the panel goes away. The session owns the
 * channel, so the id alone is not enough to read it: the endpoint is the
 * session's, and a channel belonging to another session is refused there.
 */
import { useEffect, useRef, useState } from "react";

import { openAgentTextStreamAt } from "@/lib/clients/agent-text-stream-client";
import {
  EMPTY_STREAMED_TURN,
  applyStreamDelivery,
  type StreamedTurn,
} from "@/lib/chat/streamed-turn";

export function useTeamTextStream(params: {
  sessionId: string | undefined;
  channelId: string | undefined;
}): StreamedTurn {
  const { sessionId, channelId } = params;
  const [streamedTurn, setStreamedTurn] = useState<StreamedTurn>(
    EMPTY_STREAMED_TURN,
  );
  // Identity fence: a delivery from a subscription this hook has moved on from
  // paints nothing, even if it arrives after the next one has opened.
  const tokenRef = useRef<object | null>(null);

  // Cleared during render rather than in an effect. An effect runs after the
  // paint, so a new run's first frame would briefly show the previous run's
  // text under the new run's speakers.
  const [renderedChannelId, setRenderedChannelId] = useState(channelId);
  if (renderedChannelId !== channelId) {
    setRenderedChannelId(channelId);
    setStreamedTurn(EMPTY_STREAMED_TURN);
  }

  useEffect(() => {
    if (!sessionId || !channelId) {
      tokenRef.current = null;
      return;
    }

    const token = {};
    tokenRef.current = token;
    const abort = new AbortController();

    void openAgentTextStreamAt({
      path: `/sessions/${encodeURIComponent(sessionId)}/agent-chat/stream`,
      channelId,
      signal: abort.signal,
      onDelivery: (delivery) => {
        if (tokenRef.current !== token) return;
        setStreamedTurn((current) => applyStreamDelivery(current, delivery));
      },
    }).catch(() => {
      // The preview is optional. The run's own events still arrive, and the
      // durable message is what the transcript shows either way.
    });

    return () => {
      abort.abort();
      if (tokenRef.current === token) tokenRef.current = null;
    };
  }, [sessionId, channelId]);

  return streamedTurn;
}
