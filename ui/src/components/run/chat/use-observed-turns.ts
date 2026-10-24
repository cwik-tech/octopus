import { useEffect, useMemo, useRef, useState } from 'react';
import { openAgentTextStream } from '@/lib/clients/session-client';
import { applyStreamDelivery, EMPTY_STREAMED_TURN, type StreamedTurn } from '@/lib/chat/streamed-turn';

const MAX_OBSERVED_TURNS = 100;
interface Subscription { readonly abort: AbortController }

/** One subscription per external turn. Local Stop never aborts these sends. */
export function useObservedTurns({ sessionId, activeTurnIds, ownTurnId, onSettled }: {
  sessionId: string | null;
  activeTurnIds: readonly string[];
  ownTurnId: string | null;
  onSettled: () => void;
}) {
  const subscriptions = useRef(new Map<string, Subscription>());
  const [snapshot, setSnapshot] = useState<{ sessionId: string; streams: Readonly<Record<string, StreamedTurn>> } | null>(null);
  const wanted = useMemo(() => [...new Set(activeTurnIds)].filter((id) => id !== ownTurnId).slice(0, MAX_OBSERVED_TURNS), [activeTurnIds, ownTurnId]);
  useEffect(() => {
    const current = subscriptions.current;
    return () => { for (const subscription of current.values()) subscription.abort.abort(); current.clear(); };
  }, [sessionId]);
  useEffect(() => {
    const current = subscriptions.current;
    for (const [id, subscription] of current) {
      if (!wanted.includes(id)) { subscription.abort.abort(); current.delete(id); }
    }
    if (!sessionId) return;
    for (const turnId of wanted) {
      if (current.has(turnId)) continue;
      const abort = new AbortController();
      const subscription = { abort };
      // A new subscription replays from zero, so it owns a fresh accumulator.
      let subscriptionStream = EMPTY_STREAMED_TURN;
      current.set(turnId, subscription);
      // The network reader validates frames and handles reconnects; cancellation
      // belongs only to this view's preview, not to the external turn itself.
      void openAgentTextStream({ sessionId, channelId: turnId, signal: abort.signal,
        onDelivery: (delivery) => {
          if (abort.signal.aborted || current.get(turnId) !== subscription) return;
          const next = applyStreamDelivery(subscriptionStream, delivery);
          subscriptionStream = next;
          setSnapshot((previous) => {
            const streams = previous?.sessionId === sessionId ? previous.streams : {};
            const retained = Object.fromEntries(Object.entries(streams).filter(([id]) => current.has(id)));
            return { sessionId, streams: { ...retained, [turnId]: next } };
          });
        },
      }).then(() => { if (!abort.signal.aborted) onSettled(); }).catch(() => {
        // A lost preview does not cancel its owner or replace durable messages.
      });
    }
  }, [sessionId, wanted, onSettled]);
  const streams = snapshot?.sessionId === sessionId ? snapshot.streams : {};
  const visible = wanted.map((id) => ({ id, stream: streams[id] ?? EMPTY_STREAMED_TURN }));
  const stream: StreamedTurn = {
    progress: visible.flatMap(({ id, stream }) => (stream.progress ?? []).map(entry => ({ ...entry, replyId: `${entry.replyId}:${id}` }))),
    replies: visible.flatMap(({ id, stream }) => stream.replies.map((reply) => ({ ...reply, replyId: `${reply.replyId}:${id}` }))),
    selections: visible.flatMap(({ id, stream }) => stream.selections.map((selection) => ({ ...selection, replyId: `${selection.replyId}:${id}` }))),
    partialView: visible.some(({ stream }) => stream.partialView),
    channelLost: visible.some(({ stream }) => stream.channelLost),
  };
  return { stream, pendingTurnId: wanted[0] ?? null };
}
