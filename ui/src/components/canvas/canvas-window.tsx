import { TooltipProvider } from '@/components/ui/tooltip'
import { useTheme } from '@/hooks/use-theme'
import { CanvasSession } from './canvas-session'
import { CanvasPanel } from './canvas-panel'

export function CanvasWindow({ sessionId }: { sessionId: string }) {
  useTheme()
  return <TooltipProvider><div className="desktop-shell flex h-screen flex-col overflow-hidden bg-background p-3 pt-0">
    <header className="desktop-titlebar h-11 shrink-0 pl-21.5 text-sm leading-11 text-muted-foreground">Octopus Canvas</header>
    <div className="min-h-0 flex-1"><CanvasSession sessionId={sessionId} standalone><CanvasPanel /></CanvasSession></div>
  </div></TooltipProvider>
}
