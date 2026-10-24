"use client"

import { GripVerticalIcon } from "lucide-react"
import * as React from "react"
import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils/utils"

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const ResizablePanel = React.forwardRef<
  React.ElementRef<typeof ResizablePrimitive.Panel>,
  React.ComponentProps<typeof ResizablePrimitive.Panel>
>(({ ...props }, ref) => (
  <ResizablePrimitive.Panel ref={ref} data-slot="resizable-panel" {...props} />
))
ResizablePanel.displayName = "ResizablePanel"

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-4 shrink-0 items-center justify-center outline-none transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border hover:after:bg-ring focus-visible:ring-2 focus-visible:ring-ring/50 data-[panel-group-direction=vertical]:h-4 data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:inset-x-0 data-[panel-group-direction=vertical]:after:inset-y-auto data-[panel-group-direction=vertical]:after:top-1/2 data-[panel-group-direction=vertical]:after:h-px data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 [&[data-panel-group-direction=vertical]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-8 w-4 items-center justify-center rounded-md border border-border bg-background shadow-sm">
          <GripVerticalIcon className="size-3 text-muted-foreground" />
        </div>
      ) : null}
    </ResizablePrimitive.PanelResizeHandle>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
