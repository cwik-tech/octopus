import type { CreateListTab } from "@/hooks/use-create-workspace-controller";
import type { LibrarySection } from "@/hooks/use-library-workspace-controller";

export const navigationTabs = [
  {
    value: "run",
    label: "Run",
    description: "Run an existing workflow",
  },
  {
    value: "create",
    label: "Create",
    description: "Create a workflow, agent, or skill",
  },
  {
    value: "library",
    label: "Library",
    description: "Browse workspace projects and sessions",
  },
] as const;

export type NavigationTab = (typeof navigationTabs)[number]["value"];

export const createNewActionLabels: Record<CreateListTab, string> = {
  agents: "New agent",
  teams: "New team",
  workflows: "New workflow",
};

const libraryNewActionLabels: Record<LibrarySection, string> = {
  projects: "New project",
  skills: "New skill",
  agents: "Import resources",
  teams: "Import resources",
  packages: "Import resources",
};

export function getNewActionPresentation({
  activeTab,
  createTab,
  isCreatingSession,
  librarySection = "projects",
  libraryActionReady = true,
}: {
  activeTab: NavigationTab;
  createTab: CreateListTab;
  isCreatingSession: boolean;
  librarySection?: LibrarySection;
  libraryActionReady?: boolean;
}) {
  return {
    disabled: (activeTab === "run" && isCreatingSession) || (activeTab === "library" && !libraryActionReady),
    label:
      activeTab === "run"
        ? "New chat"
        : activeTab === "library"
          ? libraryNewActionLabels[librarySection]
          : createNewActionLabels[createTab],
  };
}

