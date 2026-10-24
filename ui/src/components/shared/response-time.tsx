import { Timer } from "lucide-react";
import { useEffect, useState } from "react";

import { formatElapsedDuration } from "@/components/run/tasks/task-timing";

/**
 * How long an Agent has worked on a reply, measured from the moment its
 * question was sent.
 *
 * A reply still in progress counts up every second. A saved reply passes its
 * own publication time and keeps that final duration. The label appears on
 * hover over the enclosing `group/message`.
 */
export function ResponseTime({
  startedAt,
  completedAt,
}: {
  startedAt: number;
  completedAt?: number | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = completedAt === undefined;

  useEffect(() => {
    if (!running) return;
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [running]);

  return (
    <span
      aria-label="Response time"
      className="flex shrink-0 items-center gap-1 pl-1 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100"
      role="timer"
      title="Response time"
    >
      <Timer aria-hidden="true" className="size-3.5" />
      {formatElapsedDuration((completedAt ?? now) - startedAt)}
    </span>
  );
}
