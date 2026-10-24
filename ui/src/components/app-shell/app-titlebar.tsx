import type { RefObject } from "react";

import appIcon from "@/assets/app-icon.png";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navigationTabs } from "@/lib/utils/app-navigation";

export function AppTitlebar({
  headerRef,
  leftSidebarOpen,
}: {
  headerRef: RefObject<HTMLElement | null>;
  leftSidebarOpen: boolean;
}) {
  return (
    <header
      ref={headerRef}
      className="desktop-titlebar z-30 h-11 shrink-0 border-b border-border/70 bg-[var(--desktop-chrome)]"
    >
      <div
        className={[
          "grid h-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 pt-px pr-3",
          // The sidebar animates its width over 300ms, which slides this header
          // with it. Matching that timing keeps the offsets below in step with
          // the slide instead of snapping ahead of it.
          "transition-[padding] duration-300 ease-out",
          leftSidebarOpen ? "pl-3" : "pl-21.5",
        ].join(" ")}
      >
        <div className="flex min-w-0 items-center">
          <img
            src={appIcon}
            alt=""
            draggable={false}
            className={[
              "h-6 w-6 shrink-0 select-none",
              // The floating window actions sit at a fixed left-21.5 from the window
              // edge. A closed sidebar puts them inside this cell, so clear
              // their width and land the icon just right of the new action.
              "transition-[margin] duration-300 ease-out",
              leftSidebarOpen ? "" : "ml-19",
            ].join(" ")}
          />
        </div>
        <div className="flex min-w-0 max-w-full items-center justify-center gap-4 justify-self-center">
          <TabsList className="h-8 shrink-0 rounded-lg bg-secondary/80 p-0.5 dark:bg-transparent">
            {navigationTabs.map((tab) => (
              <Tooltip key={tab.value}>
                <TooltipTrigger
                  render={
                    <TabsTrigger
                      value={tab.value}
                      className="h-7 w-20 rounded-md px-3 text-sm data-active:bg-card group-data-[variant=default]/tabs-list:data-active:shadow-sm dark:data-active:border-transparent dark:data-active:bg-popover"
                    />
                  }
                >
                  {tab.label}
                </TooltipTrigger>
                <TooltipContent side="bottom"><p>{tab.description}</p></TooltipContent>
              </Tooltip>
            ))}
          </TabsList>
        </div>
        <div />
      </div>
    </header>
  );
}
