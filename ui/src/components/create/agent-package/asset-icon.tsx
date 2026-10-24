import { Bot, FileCode2, FileText, ScrollText, Wrench } from "lucide-react";

import type {
  AgentAssetKind,
  AgentPackageAddKind,
} from "@/lib/models/agent-generator-model";

export function AssetIcon(props: {
  kind: AgentAssetKind | AgentPackageAddKind;
}) {
  const className = "mt-0.5 size-3.5 shrink-0 text-muted-foreground";
  if (props.kind === "script") return <FileCode2 className={className} />;
  if (props.kind === "template") return <FileText className={className} />;
  if (props.kind === "reference") return <ScrollText className={className} />;
  if (props.kind === "skill") return <Wrench className={className} />;
  return <Bot className={className} />;
}
