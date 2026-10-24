import { Bot, Cable, CalendarClock, FolderLock, FolderOpen, Settings, Telescope } from "lucide-react";
import { useState, type ReactNode } from "react";

import { McpSettings } from "@/components/settings/mcp-settings";
import { ProviderSettings } from "@/components/settings/provider-settings";
import { ResearchAcquisitionSettings } from "@/components/settings/research-acquisition-settings";
import { SchedulingQueueSettings } from "@/components/settings/scheduling-queue-settings";
import { BatchFolderSettings } from "@/components/settings/batch-folder-settings";
import { SharedFolderSettings } from "@/components/settings/shared-folder-settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils/utils";

export type SettingsSection =
  | "providers"
  | "mcps"
  | "research-acquisition"
  | "scheduling-queue"
  | "batch-folders"
  | "shared-folders";

interface SectionDefinition {
  description: string;
  icon: ReactNode;
  id: SettingsSection;
  label: string;
  render: (options: {
    onSchedulingSaved?: (() => void | Promise<void>) | undefined;
  }) => ReactNode;
}

// One table drives the nav order, the header, and the body. Adding a section
// means adding a row here and nothing else.
const SECTIONS: readonly [SectionDefinition, ...SectionDefinition[]] = [
  {
    id: "providers",
    label: "AI Providers",
    icon: <Bot />,
    description: "Manage API connections, local model servers, and detected CLI agents.",
    render: () => <ProviderSettings />,
  },
  {
    id: "research-acquisition",
    label: "Research & Acquisition",
    icon: <Telescope />,
    description: "Configure research limits, source acquisition, managed Chrome, and the optional Webshare proxy.",
    render: () => <ResearchAcquisitionSettings />,
  },
  {
    id: "mcps",
    label: "MCPs",
    icon: <Cable />,
    description: "Connect MCP servers and control whether agents may use them globally.",
    render: () => <McpSettings />,
  },
  {
    id: "scheduling-queue",
    label: "Scheduling and Queue",
    icon: <CalendarClock />,
    description: "Control task and workflow execution capacity for this workspace.",
    render: ({ onSchedulingSaved }) => <SchedulingQueueSettings onSaved={onSchedulingSaved} />,
  },
  {
    id: "batch-folders",
    label: "Batch folders",
    icon: <FolderOpen />,
    description: "Review and revoke external folder access granted by the desktop picker.",
    render: () => <BatchFolderSettings />,
  },
  {
    id: "shared-folders",
    label: "Shared folders",
    icon: <FolderLock />,
    description: "Review and revoke the folders agents may search and read.",
    render: () => <SharedFolderSettings />,
  },
];

export function SettingsDialog({
  open,
  initialSection = "providers",
  onOpenChange,
  onSchedulingSaved,
}: {
  open: boolean;
  initialSection?: SettingsSection | undefined;
  onOpenChange: (open: boolean) => void;
  onSchedulingSaved?: () => void | Promise<void>;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(820px,calc(100vh-3rem))] w-[min(1180px,calc(100vw-3rem))] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none">
        <aside className="absolute inset-y-0 left-0 w-64 border-r border-border/70 bg-sidebar p-4">
          <div className="mb-6 flex items-center gap-2 px-2 text-base font-semibold">
            <Settings className="size-4" />
            Settings
          </div>
          <nav aria-label="Settings sections" className="space-y-1">
            {SECTIONS.map((entry) => {
              const current = entry.id === active.id;
              return (
                <Button
                  key={entry.id}
                  variant="ghost"
                  size="lg"
                  aria-current={current ? "page" : undefined}
                  onClick={() => setSection(entry.id)}
                  className={cn(
                    "w-full justify-start gap-2 px-3",
                    current
                      ? "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent"
                      : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60",
                  )}
                >
                  {entry.icon}
                  {entry.label}
                </Button>
              );
            })}
          </nav>
          <p className="absolute bottom-4 left-6 text-xs text-sidebar-foreground/50">
            Version {import.meta.env.VITE_APP_VERSION}
          </p>
        </aside>

        <div className="desktop-shell ml-64 min-w-0 flex-1 overflow-y-auto p-7">
          <header className="mb-6 pr-10">
            <DialogTitle className="text-2xl">{active.label}</DialogTitle>
            <DialogDescription className="mt-2">{active.description}</DialogDescription>
          </header>
          {active.render({ onSchedulingSaved })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
