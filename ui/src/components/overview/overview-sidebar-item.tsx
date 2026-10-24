import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function OverviewSidebarItem({
  badge,
  description,
  icon,
  label,
  onClick,
  selected = false,
}: {
  badge?: number | string | undefined;
  description: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  selected?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={[
        "mb-3 h-auto w-full justify-start gap-2.5 px-2.5 py-2 text-left font-normal",
        selected
          ? "bg-sidebar-primary/16 text-sidebar-foreground ring-1 ring-sidebar-primary/35 hover:bg-sidebar-primary/16"
          : "text-sidebar-foreground/82 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-sidebar-foreground/50">
          {description}
        </span>
      </span>
      {badge !== undefined ? (
        <span className="min-w-5 rounded-full bg-sidebar-accent px-1.5 py-0.5 text-center text-xs font-medium tabular-nums text-sidebar-foreground/70">
          {badge}
        </span>
      ) : null}
    </Button>
  );
}
