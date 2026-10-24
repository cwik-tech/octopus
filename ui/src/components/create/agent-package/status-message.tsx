import type { ReactNode } from "react";

import { cn } from "@/lib/utils/utils";

export function StatusMessage(props: {
  children: ReactNode;
  tone: "error" | "success";
}) {
  return (
    <div
      className={cn(
        "mt-3 shrink-0 rounded-lg border px-3 py-2 text-xs",
        props.tone === "error"
          ? "border-destructive/30 bg-destructive/8 text-destructive"
          : "border-emerald-500/30 bg-emerald-500/8 text-emerald-700",
      )}
    >
      {props.children}
    </div>
  );
}
