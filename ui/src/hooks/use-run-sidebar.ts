import { createContext, useContext } from "react";

export type RunSidebarTab = "sessions" | "teams" | "agents" | "workflows";

export function isRunSidebarTab(value: unknown): value is RunSidebarTab {
  return value === "sessions" || value === "teams" || value === "agents" || value === "workflows";
}

interface RunSidebarNavigation {
  tab: RunSidebarTab;
  setTab: (tab: RunSidebarTab) => void;
  query: string;
  setQuery: (query: string) => void;
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  targetsAvailable: boolean;
  unavailableReason: string | undefined;
}

export const RunSidebarContext = createContext<RunSidebarNavigation | undefined>(undefined);

export function useRunSidebar() {
  return useContext(RunSidebarContext);
}
