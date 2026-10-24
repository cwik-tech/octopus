import { CircleAlert } from "lucide-react";

export function SidebarError({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
