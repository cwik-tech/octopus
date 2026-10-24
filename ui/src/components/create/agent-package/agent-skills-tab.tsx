import { Wrench } from "lucide-react";

import { TabsContent } from "@/components/ui/tabs";
import type {
  AgentDetail,
  AgentPackageAddKind,
  AgentPackageFileInput,
} from "@/lib/models/agent-generator-model";
import { AddPackageFilesButton } from "./add-package-files-button";
import { EmptyTab } from "./empty-tab";
import { PackageItem } from "./package-item";
import { SmallCount } from "./small-count";
import { StatusMessage } from "./status-message";
import type { PendingRemoval } from "./types";

export function AgentSkillsTab(props: {
  agentName: string | null;
  agentDetail: AgentDetail | null;
  packageBusyKey: string | null;
  revealError: string | null;
  packageError: string | null;
  onRevealAsset: (path: string) => void | Promise<void>;
  onStartImport: (
    kind: AgentPackageAddKind,
    files: AgentPackageFileInput[],
  ) => void | Promise<void>;
  onRequestRemove: (pendingRemoval: PendingRemoval) => void;
}) {
  return (
    <TabsContent value="skills" className="min-h-0 flex-1 overflow-y-auto p-3">
      {props.agentDetail && props.agentDetail.skillDetails.length > 0 ? (
        <div className="space-y-2">
          {props.agentDetail.skillDetails.map((skill) => (
            <PackageItem
              key={skill.name}
              onReveal={() => props.onRevealAsset(skill.path)}
              onRemove={() =>
                props.onRequestRemove({
                  kind: "skill",
                  agentPath: skill.name,
                  label: skill.name,
                })
              }
              removing={
                props.packageBusyKey === `remove:skill:${skill.name}` ||
                props.packageBusyKey === `remove:skill:skills/${skill.name}`
              }
              disabled={props.packageBusyKey !== null}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-xs font-medium">
                      {skill.name}
                    </span>
                  </div>
                  {skill.description ? (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {skill.description}
                    </p>
                  ) : null}
                  <p className="mt-2 truncate font-mono text-xs text-muted-foreground/80">
                    {skill.path}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  <SmallCount label="files" count={skill.files.length} />
                  <SmallCount label="tpl" count={skill.templateCount} />
                  <SmallCount label="ref" count={skill.referenceCount} />
                  <SmallCount label="scr" count={skill.scriptCount} />
                </div>
              </div>
            </PackageItem>
          ))}
        </div>
      ) : (
        <EmptyTab>No attached skills.</EmptyTab>
      )}
      <AddPackageFilesButton
        className="mt-3"
        kind="skill"
        disabled={!props.agentName || props.packageBusyKey !== null}
        busy={props.packageBusyKey === "preview:skill"}
        onFiles={(files) => void props.onStartImport("skill", files)}
      />
      {props.revealError ? (
        <StatusMessage tone="error">{props.revealError}</StatusMessage>
      ) : null}
      {props.packageError ? (
        <StatusMessage tone="error">{props.packageError}</StatusMessage>
      ) : null}
    </TabsContent>
  );
}
