import type { ReactNode } from "react";

import {
  OverviewHeader,
  type OverviewHeaderTabs,
} from "@/components/overview/overview-header";
import { cn } from "@/lib/utils/utils";

export type { OverviewHeaderTab, OverviewHeaderTabs } from "@/components/overview/overview-header";

export function OverviewPanel({
  actions,
  children,
  description,
  tabs,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  description: string;
  /** Replaces the title with a tab strip that swaps the whole panel. */
  tabs?: OverviewHeaderTabs | undefined;
  title: string;
}) {
  return (
    <section
      aria-label={tabs ? title : undefined}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <OverviewHeader actions={actions} description={description} tabs={tabs} title={title} />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export function OverviewStats({
  children,
  columns = 3,
}: {
  children: ReactNode;
  columns?: 3 | 4;
}) {
  return (
    <div className={columns === 4 ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-4" : "grid gap-3 sm:grid-cols-3"}>
      {children}
    </div>
  );
}

/**
 * Panels have no background of their own, so the cards nested inside them use
 * the sunken surface to stay a step darker than the page.
 */
const INNER_CARD_SURFACE = "border border-border/60 bg-surface-sunken";

export function OverviewStat({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className={cn("rounded-lg px-4 py-3", INNER_CARD_SURFACE)}>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

export function OverviewSection({
  children,
  count,
  title,
}: {
  children: ReactNode;
  count?: number;
  title: string;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        {count !== undefined ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function OverviewRow({
  actions,
  children,
  status,
}: {
  actions?: ReactNode;
  children: ReactNode;
  status?: "waiting" | "starting" | "running" | "finishing" | undefined;
}) {
  return (
    <div className={cn("flex items-center gap-4 rounded-lg px-4 py-3", INNER_CARD_SURFACE)}>
      {status ? (
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            status === "running" && "bg-emerald-500",
            status === "starting" && "bg-sky-500",
            status === "finishing" && "bg-amber-500",
            status === "waiting" && "bg-muted-foreground/45",
          )}
        />
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
