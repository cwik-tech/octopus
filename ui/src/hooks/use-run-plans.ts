import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

import { getSessionRunPlan as apiGetSessionRunPlan } from "@/lib/clients/session-client";
import type { RunPlan } from "@/lib/models/session-model";

export function useRunPlans({
  selectedSessionId,
  selectedSessionIsDraft = false,
  setRunPlanBySessionId,
}: {
  selectedSessionId: string | null;
  /** A draft has no plan to fetch, and asking for one would be a 404. */
  selectedSessionIsDraft?: boolean;
  setRunPlanBySessionId: Dispatch<SetStateAction<Record<string, RunPlan>>>;
}) {
  const runPlanVersionBySessionIdRef = useRef<Record<string, number>>({});

  const handleRunPlanUpdated = useCallback(
    (sessionId: string, plan: RunPlan) => {
      runPlanVersionBySessionIdRef.current[sessionId] =
        (runPlanVersionBySessionIdRef.current[sessionId] ?? 0) + 1;
      setRunPlanBySessionId((current) => ({ ...current, [sessionId]: plan }));
    },
    [setRunPlanBySessionId],
  );

  useEffect(() => {
    if (!selectedSessionId || selectedSessionIsDraft) return;
    let cancelled = false;
    const versionAtRequest =
      runPlanVersionBySessionIdRef.current[selectedSessionId] ?? 0;
    void apiGetSessionRunPlan(selectedSessionId)
      .then((plan) => {
        if (
          cancelled ||
          (runPlanVersionBySessionIdRef.current[selectedSessionId] ?? 0) !==
            versionAtRequest
        ) {
          return;
        }
        setRunPlanBySessionId((current) => {
          if (plan) return { ...current, [selectedSessionId]: plan };
          const next = { ...current };
          delete next[selectedSessionId];
          return next;
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("[RunPanel] Failed to load run plan", error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, selectedSessionIsDraft, setRunPlanBySessionId]);

  return { handleRunPlanUpdated };
}
