import { formatDisplayName } from "@/lib/utils/display-name";

export function agentInitials(name: string): string {
  const parts = formatAgentDisplayName(name)
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return parts
      .slice(0, 2)
      .map((part) => part[0] ?? "")
      .join("")
      .toUpperCase();
  }
  return (
    (parts[0] ?? "?")
      .replaceAll(/[^a-z0-9]/gi, "")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function formatAgentDisplayName(name: string): string {
  return formatDisplayName(name);
}
