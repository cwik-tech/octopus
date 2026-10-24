import type { AgentPackageAddKind } from "@/lib/models/agent-generator-model";
import { TabsContent } from "@/components/ui/tabs";
import {
  AgentAssetSection,
  type AgentAssetSectionProps,
} from "./agent-asset-section";

export function AgentAssetsTab(
  props: Omit<AgentAssetSectionProps, "kind"> & {
    value: "templates" | "references" | "scripts" | "context";
  },
) {
  return (
    <TabsContent
      value={props.value}
      className="min-h-0 flex-1 overflow-y-auto p-3"
    >
      <AgentAssetSection {...props} kind={packageKindForTab(props.value)} />
    </TabsContent>
  );
}

function packageKindForTab(
  value: "templates" | "references" | "scripts" | "context",
): Exclude<AgentPackageAddKind, "skill"> {
  if (value === "templates") return "template";
  if (value === "references") return "reference";
  if (value === "scripts") return "script";
  return "context";
}
