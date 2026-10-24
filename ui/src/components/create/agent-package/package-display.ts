import type { AgentPackageImportAction } from "@/lib/models/agent-generator-model";

export function formatImportAction(action: AgentPackageImportAction): string {
  if (action === "add") return "Add";
  if (action === "skip") return "Skip";
  if (action === "replace") return "Replace";
  return "Keep both";
}
