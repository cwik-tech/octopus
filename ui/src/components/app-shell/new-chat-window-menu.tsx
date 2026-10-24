import type { ReactNode } from 'react';
import { AppWindow } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useOpenAppWindow } from '@/hooks/use-open-app-window';

export function NewChatWindowMenu({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { available, opening, open } = useOpenAppWindow();
  if (!enabled || !available) return children;
  return <ContextMenu>
    <ContextMenuTrigger render={<div className="flex" />}>{children}</ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem disabled={opening} onClick={() => { void open({ kind: 'new-chat' }); }}>
        <AppWindow className="size-4" />New chat in new window
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
}
