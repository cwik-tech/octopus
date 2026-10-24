import { useEffect } from "react";

import { isValidSessionId } from "@contracts/sessions";

/**
 * Opens the session a voice layer asked to see. The request arrives from the
 * Electron main process after the server checked that the session exists; it
 * is checked again here because it crossed a process boundary.
 */
export function useVoiceNavigation(openSession: (sessionId: string) => void): void {
  useEffect(() => {
    const subscribe = window.pipeline?.onVoiceNavigate;
    if (!subscribe) return undefined;
    return subscribe((target) => {
      const sessionId = sessionIdOf(target);
      if (sessionId !== undefined) openSession(sessionId);
    });
  }, [openSession]);
}

function sessionIdOf(target: unknown): string | undefined {
  if (typeof target !== "object" || target === null || !("sessionId" in target)) {
    return undefined;
  }
  const sessionId = target.sessionId;
  return typeof sessionId === "string" && isValidSessionId(sessionId) ? sessionId : undefined;
}
