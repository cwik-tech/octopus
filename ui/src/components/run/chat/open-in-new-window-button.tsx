import { AppWindow, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOpenAppWindow } from '@/hooks/use-open-app-window';

export function OpenInNewWindowButton({ sessionId, isDraft }: { sessionId: string | undefined; isDraft: boolean }) {
  const { available, opening, open } = useOpenAppWindow();
  if (!available) return null;
  return <Tooltip>
    <TooltipTrigger render={<span className="inline-flex" />}>
      <Button variant="ghost" size="icon" aria-label="Open in new window"
        disabled={isDraft || !sessionId || opening}
        onClick={() => { if (sessionId) void open({ kind: 'session', sessionId }); }}>
        {opening ? <Loader2 className="size-4 animate-spin" /> : <AppWindow className="size-4" />}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{isDraft ? 'Send a message first' : 'Open in new window'}</TooltipContent>
  </Tooltip>;
}
