import { useEffect, useRef } from 'react';
import { readInitialSessionId } from '@/lib/utils/desktop';

/** Launch state is read once; later navigation remains local to this window. */
export function useInitialSession(openSession: (sessionId: string) => void): void {
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const sessionId = readInitialSessionId();
    if (sessionId) openSession(sessionId);
  }, [openSession]);
}
