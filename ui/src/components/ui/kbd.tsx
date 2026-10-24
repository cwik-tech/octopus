import { cn } from "@/lib/utils/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "bg-muted text-muted-foreground pointer-events-none isolate flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-sm px-1 font-sans text-xs font-medium tabular-nums",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
