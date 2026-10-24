import { useEffect, useMemo, useRef, useState } from "react";

import { researchFaviconUrl } from "@/lib/clients/research-activity-client";

/** Enough parallelism to fill a visible table quickly, without flooding the API. */
const MAX_CONCURRENT_ICON_FETCHES = 4;

/** One shared instance, so a stale-session render keeps a stable identity. */
const EMPTY_ICONS: ReadonlyMap<string, string> = new Map();

/**
 * How long one icon request may run.
 *
 * Decoration must never hold a concurrency slot indefinitely: without this a
 * single hung origin would starve the other icons in the table.
 */
const SITE_ICON_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Blob URLs for the site icons of origins this session visited.
 *
 * Fetched rather than linked, because the renderer's CSP allows images only
 * from 'self', data: and blob: while the API lives on a loopback origin.
 *
 * Work is incremental: an origin is attempted once and never again for the life
 * of the session, so the 1.5s activity poll re-rendering this list does not
 * refetch anything. Only origins never seen before are queued.
 */
export function useSiteIcons(
  sessionId: string | null,
  origins: readonly string[],
): ReadonlyMap<string, string> {
  // State carries the session it belongs to. Render then only ever reads, and a
  // map from a previous session is never handed out even for a single paint.
  const [mapped, setMapped] = useState<{
    sessionId: string | null;
    icons: ReadonlyMap<string, string>;
  }>({ sessionId, icons: new Map() });
  const attempted = useRef(new Set<string>());
  const objectUrls = useRef<string[]>([]);
  // Depend on the contents rather than the array identity, so a poll returning
  // the same origins does not look like new work.
  const key = useMemo(() => [...new Set(origins)].sort().join("\n"), [origins]);

  // Leaving a session releases its icons and its attempt history. The new
  // session's tag is adopted by the first icon that lands for it; until then
  // the returned map reads empty, so nothing stale is ever shown.
  useEffect(() => {
    const created = objectUrls;
    const seen = attempted;
    return () => {
      for (const objectUrl of created.current) URL.revokeObjectURL(objectUrl);
      created.current = [];
      seen.current = new Set<string>();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    const pending = key
      ? key.split("\n").filter((origin) => !attempted.current.has(origin))
      : [];
    if (pending.length === 0) return;
    for (const origin of pending) attempted.current.add(origin);

    const queue = [...pending];
    // Every in-flight request, so leaving the view or the session stops them
    // rather than letting them settle into state nobody is watching.
    const inFlight = new Set<AbortController>();
    const drain = async (): Promise<void> => {
      for (;;) {
        const origin = queue.shift();
        if (!origin || disposed) return;
        const controller = new AbortController();
        inFlight.add(controller);
        const deadline = window.setTimeout(
          () => controller.abort(),
          SITE_ICON_REQUEST_TIMEOUT_MS,
        );
        try {
          const response = await fetch(researchFaviconUrl(sessionId, origin), {
            signal: controller.signal,
          });
          if (!response.ok || disposed) continue;
          const objectUrl = URL.createObjectURL(await response.blob());
          if (disposed) {
            URL.revokeObjectURL(objectUrl);
            return;
          }
          objectUrls.current.push(objectUrl);
          // `disposed` already excluded results from an abandoned session, so
          // anything arriving here belongs to `sessionId`. State still tagged
          // with an earlier session is replaced rather than merged into.
          setMapped((current) => current.sessionId === sessionId
            ? { sessionId, icons: new Map(current.icons).set(origin, objectUrl) }
            : { sessionId, icons: new Map([[origin, objectUrl]]) });
        } catch {
          // A site without a reachable icon, or one that ran out of time,
          // simply keeps its fallback glyph.
        } finally {
          window.clearTimeout(deadline);
          inFlight.delete(controller);
        }
      }
    };
    // Detached on purpose: the workers own their own errors and update state as
    // each icon lands, so there is nothing for the effect to await. Cancellation
    // runs through `disposed` and the abort below.
    void Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_ICON_FETCHES, queue.length) }, drain),
    );

    return () => {
      disposed = true;
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
    };
  }, [key, sessionId]);

  // Render only reads. State still tagged with a previous session reads as
  // empty until that session's own effect has replaced it.
  return mapped.sessionId === sessionId ? mapped.icons : EMPTY_ICONS;
}
