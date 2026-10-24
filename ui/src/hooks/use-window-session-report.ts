import { useEffect } from 'react';

/** Routing hint only. Drafts and views outside Run report no saved session. */
export function useWindowSessionReport(sessionId: string | null): void {
  useEffect(() => {
    const report = window.pipeline?.reportWindowSession;
    if (!report) return;
    report(sessionId);
    return () => report(null);
  }, [sessionId]);
}
