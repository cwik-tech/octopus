import { useEffect } from "react";

import { isValidSessionId } from "@contracts/sessions";

export function useVoiceSessionRefresh(sessionId: string | null, refresh: () => void): void {
  useEffect(() => {
    const subscribe = window.pipeline?.onVoiceSessionChanged;
    if (!subscribe) return undefined;
    return subscribe((target) => {
      if (typeof target !== "object" || target === null || !("sessionId" in target)) return;
      const changedSessionId = target.sessionId;
      if (typeof changedSessionId === "string" && isValidSessionId(changedSessionId) && changedSessionId === sessionId) {
        refresh();
      }
    });
  }, [sessionId, refresh]);
}
