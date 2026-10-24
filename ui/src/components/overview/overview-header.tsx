import type { ReactNode } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface OverviewHeaderTab {
  id: string;
  label: string;
}

export interface OverviewHeaderTabs {
  activeId: string;
  ariaLabel: string;
  items: OverviewHeaderTab[];
  onSelect: (id: string) => void;
}

/**
 * The heading block every overview panel shares.
 *
 * Two rows, both flush with the panel's left edge so the identity line and the
 * description align:
 *   1. identity — a tab strip when the panel has tabs, otherwise the title
 *   2. the description and the panel's actions, centred against each other
 */
export function OverviewHeader({
  actions,
  description,
  tabs,
  title,
}: {
  actions?: ReactNode;
  description: string;
  tabs?: OverviewHeaderTabs | undefined;
  title: string;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-3 pb-6">
      {tabs ? (
        <OverviewHeaderTabStrip tabs={tabs} />
      ) : (
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      )}
      <div className="flex items-center justify-between gap-4">
        <p className="min-w-0 text-sm text-muted-foreground">{description}</p>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

function OverviewHeaderTabStrip({ tabs }: { tabs: OverviewHeaderTabs }) {
  return (
    <Tabs
      value={tabs.activeId}
      onValueChange={(value) => tabs.onSelect(String(value))}
      className="gap-0"
    >
      {/* Heading-sized tabs: no padding, so the first one lines up with the
          description underneath it. */}
      <TabsList variant="line" aria-label={tabs.ariaLabel} className="h-auto gap-7 p-0">
        {tabs.items.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className="h-auto flex-none px-0 text-xl font-semibold tracking-tight"
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
