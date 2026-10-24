import { X } from 'lucide-react'
import {
  createContext,
  useContext,
  useEffect,
  type ReactNode,
  type HTMLAttributes,
  type PropsWithChildren,
} from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils/utils'

interface SheetContextValue {
  onOpenChange: (open: boolean) => void
  open: boolean
}

const SheetContext = createContext<SheetContextValue | null>(null)

function useSheetContext(): SheetContextValue {
  const context = useContext(SheetContext)
  if (!context) {
    throw new Error('Sheet components must be used within <Sheet>.')
  }
  return context
}

export function Sheet({
  children,
  open,
  onOpenChange,
}: PropsWithChildren<{
  open: boolean
  onOpenChange: (open: boolean) => void
}>) {
  useEffect(() => {
    if (!open) return undefined

    const previousOverflow = document.body.style.overflow
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  return createPortal(
    <SheetContext.Provider value={{ open, onOpenChange }}>
      {children}
    </SheetContext.Provider>,
    document.body,
  )
}

export function SheetContent({
  children,
  className,
  closeLabel = 'Close artifact sheet',
  headerActions,
  headerContent,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>> & {
  closeLabel?: string
  headerActions?: ReactNode
  headerContent?: ReactNode
}) {
  const { onOpenChange, open } = useSheetContext()
  const state = open ? 'open' : 'closed'

  return (
    <div
      aria-hidden={!open}
      className={cn('fixed inset-0 z-50', !open && 'pointer-events-none')}
      data-state={state}
      inert={!open}
    >
      <button
        aria-label={closeLabel}
        className={cn(
          'absolute inset-0 bg-foreground/20 opacity-0 transition-opacity duration-300 ease-out',
          'data-[state=open]:opacity-100 data-[state=closed]:opacity-0',
        )}
        data-state={state}
        tabIndex={open ? 0 : -1}
        type="button"
        onClick={() => onOpenChange(false)}
      />
      <div
        {...props}
        className={cn(
          'absolute inset-y-0 right-0 flex w-full max-w-3xl translate-x-full flex-col border-l border-border/80 bg-background shadow-2xl transition-transform duration-300 ease-out',
          'data-[state=open]:translate-x-0 data-[state=closed]:translate-x-full',
          className,
        )}
        data-state={state}
      >
        <div
          className={cn(
            'flex min-h-14 items-center gap-3 border-b border-border/80 px-4 py-3',
            headerContent ? 'justify-between' : 'justify-end',
          )}
        >
          {headerContent ? (
            <div className="min-w-0 flex-1">{headerContent}</div>
          ) : null}
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
          <Button
            aria-label={closeLabel}
            size="icon-sm"
            tabIndex={open ? 0 : -1}
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

export function SheetHeader({
  children,
  className,
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={cn('space-y-1 border-b border-border/80 px-5 py-4', className)}>
      {children}
    </div>
  )
}

export function SheetTitle({
  children,
  className,
}: PropsWithChildren<HTMLAttributes<HTMLHeadingElement>>) {
  return (
    <h2 className={cn('font-heading text-lg font-medium text-foreground', className)}>
      {children}
    </h2>
  )
}

export function SheetDescription({
  children,
  className,
}: PropsWithChildren<HTMLAttributes<HTMLParagraphElement>>) {
  return (
    <p className={cn('text-sm text-muted-foreground', className)}>
      {children}
    </p>
  )
}
