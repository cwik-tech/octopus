import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchSchedulingQueue,
  type SchedulingQueueSnapshot,
} from "@/lib/clients/scheduling-queue-client";

const QUEUE_REFRESH_INTERVAL_MS = 1_000;

export interface SchedulingQueueState {
  snapshot: SchedulingQueueSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSchedulingQueue(enabled: boolean): SchedulingQueueState {
  const [snapshot, setSnapshot] = useState<SchedulingQueueSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const nextSnapshot = await fetchSchedulingQueue(controller.signal);
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "The queue overview could not be loaded.",
        );
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      activeRequest.current?.abort();
      activeRequest.current = null;
      return;
    }

    const initialRefreshId = window.setTimeout(() => void refresh(), 0);
    const intervalId = window.setInterval(() => void refresh(), QUEUE_REFRESH_INTERVAL_MS);
    return () => {
      window.clearTimeout(initialRefreshId);
      window.clearInterval(intervalId);
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [enabled, refresh]);

  return { snapshot, loading, error, refresh };
}
