import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

export function useOpenAppWindow() {
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);
  const available = typeof window.pipeline?.openWindow === 'function';
  const open = useCallback(async (request: { kind: 'new-chat' } | { kind: 'session'; sessionId: string }) => {
    const bridge = window.pipeline?.openWindow;
    if (!bridge || pending.current) return;
    pending.current = true;
    setOpening(true);
    try { await bridge(request); }
    catch { toast.error('Could not open a new window'); }
    finally { pending.current = false; setOpening(false); }
  }, []);
  return { available, opening, open };
}
