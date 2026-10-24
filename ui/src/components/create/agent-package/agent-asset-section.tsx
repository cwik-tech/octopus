import type {
  AgentAssetFile,
  AgentPackageAddKind,
  AgentPackageFileInput,
} from "@/lib/models/agent-generator-model";
import { AddPackageFilesButton } from "./add-package-files-button";
import { AssetIcon } from "./asset-icon";
import { EmptyTab } from "./empty-tab";
import { PackageItem } from "./package-item";
import { StatusMessage } from "./status-message";
import type { PendingRemoval } from "./types";

export interface AgentAssetSectionProps {
  kind: Exclude<AgentPackageAddKind, "skill">;
  assets: AgentAssetFile[];
  empty: string;
  onRevealAsset: (path: string) => void | Promise<void>;
  onStartImport: (
    kind: AgentPackageAddKind,
    files: AgentPackageFileInput[],
  ) => void | Promise<void>;
  onRequestRemove: (pendingRemoval: PendingRemoval) => void;
  packageBusyKey: string | null;
  revealError: string | null;
  packageError: string | null;
  agentSelected: boolean;
}

export function AgentAssetSection(props: AgentAssetSectionProps) {
  return (
    <>
      {props.assets.length > 0 ? (
        <div className="space-y-2">
          {props.assets.map((asset) => (
            <PackageItem
              key={asset.agentPath}
              onReveal={() => props.onRevealAsset(asset.path)}
              onRemove={() =>
                props.onRequestRemove({
                  kind: props.kind,
                  agentPath: asset.agentPath,
                  label: asset.agentPath,
                })
              }
              removing={props.packageBusyKey === `remove:${asset.agentPath}`}
              disabled={props.packageBusyKey !== null}
            >
              <div className="flex items-start gap-2">
                <AssetIcon kind={asset.kind} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">
                    {asset.agentPath}
                  </div>
                </div>
              </div>
            </PackageItem>
          ))}
        </div>
      ) : (
        <EmptyTab>{props.empty}</EmptyTab>
      )}
      <AddPackageFilesButton
        className="mt-3"
        kind={props.kind}
        disabled={!props.agentSelected || props.packageBusyKey !== null}
        busy={props.packageBusyKey === `preview:${props.kind}`}
        onFiles={(files) => void props.onStartImport(props.kind, files)}
      />
      {props.revealError ? (
        <StatusMessage tone="error">{props.revealError}</StatusMessage>
      ) : null}
      {props.packageError ? (
        <StatusMessage tone="error">{props.packageError}</StatusMessage>
      ) : null}
    </>
  );
}
