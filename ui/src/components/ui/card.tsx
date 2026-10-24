import * as React from "react"

import { cn } from "@/lib/utils/utils"

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-4 overflow-hidden rounded-xl bg-card py-4 text-sm text-card-foreground ring-1 ring-foreground/10 has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4 group-data-[size=sm]/card:px-3", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-4 group-data-[size=sm]/card:p-3",
        className
      )}
      {...props}
    />
  )
}

function PanelCard({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"section"> & {
  variant?: "default" | "inset"
}) {
  return (
    <section
      data-slot="panel-card"
      data-variant={variant}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-xl text-card-foreground",
        variant === "default"
          ? "border border-border/70 bg-card/90"
          : "border border-border/60 bg-background/70",
        className
      )}
      {...props}
    />
  )
}

function PanelHeader({
  className,
  icon,
  title,
  actions,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  icon?: React.ReactNode
  title?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        "flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          <div className="flex min-w-0 items-center gap-2">
            {icon}
            {title ? <PanelTitle>{title}</PanelTitle> : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </>
      )}
    </div>
  )
}

function PanelTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-title"
      className={cn(
        "truncate text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function PanelContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-content"
      className={cn("min-h-0 flex-1", className)}
      {...props}
    />
  )
}

function panelItemClassName({
  className,
  disabled,
  interactive,
  selected,
}: {
  className?: string | undefined
  disabled?: boolean | undefined
  interactive?: boolean | undefined
  selected?: boolean | undefined
}) {
  return cn(
    "rounded-lg border px-3 py-2.5 text-left transition-colors",
    selected
      ? "border-primary/30 bg-primary/8"
      : "border-border/60 bg-background/60",
    interactive && !selected ? "hover:bg-muted/55" : null,
    disabled ? "opacity-75" : null,
    className
  )
}

function PanelItem({
  className,
  disabled,
  selected = false,
  ...props
}: React.ComponentProps<"div"> & {
  disabled?: boolean
  selected?: boolean
}) {
  return (
    <div
      data-slot="panel-item"
      data-selected={selected}
      className={panelItemClassName({ className, disabled, selected })}
      {...props}
    />
  )
}

function PanelItemButton({
  className,
  disabled,
  selected = false,
  ...props
}: React.ComponentProps<"button"> & {
  selected?: boolean
}) {
  return (
    <button
      data-slot="panel-item-button"
      data-selected={selected}
      disabled={disabled}
      className={panelItemClassName({
        className,
        disabled,
        interactive: true,
        selected,
      })}
      {...props}
    />
  )
}

function PanelEmptyState({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-empty-state"
      className={cn(
        "rounded-lg border border-dashed border-border/70 bg-muted/30 px-4 py-6 text-center",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
  PanelCard,
  PanelHeader,
  PanelTitle,
  PanelContent,
  PanelItem,
  PanelItemButton,
  PanelEmptyState,
}
