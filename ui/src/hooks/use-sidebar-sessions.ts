import { useCallback, useEffect, useState } from "react";

import { listSessions } from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

export function useSidebarSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await listSessions();
      setSessions(next);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial external session sync for the desktop sidebar.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh(true);
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const updateSession = useCallback((updated: SessionSummary) => {
    setSessions((current) => [
      updated,
      ...current.filter((session) => session.id !== updated.id),
    ]);
  }, []);

  return {
    sessions,
    setSessions,
    error,
    setError,
    loading,
    refresh,
    updateSession,
  };
}
