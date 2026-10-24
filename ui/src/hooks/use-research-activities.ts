import { useEffect, useState } from "react";

import {
  isTerminalResearchActivityState,
  listResearchActivity,
  type ResearchActivity,
} from "@/lib/clients/research-activity-client";

const POLL_INTERVAL_MS = 1_500;

export function useResearchActivities(
  sessionId: string | null,
  active = false,
  pollForRunningActivity = true,
): ResearchActivity[] {
  const [snapshot, setSnapshot] = useState<{
    sessionId: string | null;
    activities: ResearchActivity[];
  }>({ sessionId: null, activities: [] });

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let controller: AbortController | undefined;
    let timer: number | undefined;
    const poll = async () => {
      let shouldContinue = active;
      controller = new AbortController();
      try {
        const next = await listResearchActivity(sessionId, controller.signal);
        shouldContinue ||=
          pollForRunningActivity &&
          next.some((activity) => !isTerminalResearchActivityState(activity.state));
        if (!disposed) setSnapshot({ sessionId, activities: next });
      } catch {
        // Research cards already surface step failures. Keep the last snapshot.
      } finally {
        if (!disposed && shouldContinue) {
          timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [active, pollForRunningActivity, sessionId]);

  return snapshot.sessionId === sessionId ? snapshot.activities : [];
}
