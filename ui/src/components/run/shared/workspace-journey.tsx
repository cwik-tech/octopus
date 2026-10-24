import {
  AlertTriangle,
  Check,
  LockKeyhole,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils/utils";
import { Button } from "@/components/ui/button";

export type WorkspaceJourneyStageState =
  | "completed"
  | "current"
  | "locked"
  | "blocked";

export interface WorkspaceJourneyStage<Id extends string = string> {
  id: Id;
  label: string;
  liveLabel?: string | undefined;
  meta?: string;
  reachable: boolean;
  state: WorkspaceJourneyStageState;
}

interface WorkspaceJourneyNavigationProps<Id extends string> {
  liveStageId: Id;
  onSelect: (stageId: Id) => void;
  renderIcon: (stage: WorkspaceJourneyStage<Id>) => ReactNode;
  selectedStageId: Id;
  stages: readonly WorkspaceJourneyStage<Id>[];
}

export function WorkspaceJourneyRail<Id extends string>({
  ariaLabel,
  footer,
  liveStageId,
  onSelect,
  progressLabel,
  renderIcon,
  selectedStageId,
  stages,
  title,
}: WorkspaceJourneyNavigationProps<Id> & {
  ariaLabel: string;
  footer?: ReactNode;
  progressLabel?: string;
  title: string;
}) {
  const reached = stages.filter((stage) => stage.reachable).length;
  const progress = stages.length > 0
    ? Math.round((reached / stages.length) * 100)
    : 0;

  return (
    <aside
      aria-label={ariaLabel}
      className="hidden h-full w-59.5 shrink-0 flex-col border-r border-border/60 bg-muted/20 xl:flex dark:bg-sidebar"
    >
      <div className="border-b border-border/60 p-4">
        <div className="text-xs font-semibold text-foreground">{title}</div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {progressLabel ?? `${reached} of ${stages.length} stages reached`}
        </p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {stages.map((stage) => (
          <WorkspaceJourneyStageButton
            isLive={stage.id === liveStageId}
            isSelected={stage.id === selectedStageId}
            key={stage.id}
            onSelect={() => onSelect(stage.id)}
            renderIcon={renderIcon}
            stage={stage}
          />
        ))}
      </nav>

      {footer ? (
        <div className="max-h-[42%] overflow-y-auto border-t border-border/60 p-3">
          {footer}
        </div>
      ) : null}
    </aside>
  );
}

export function WorkspaceCompactJourneyNav<Id extends string>({
  onSelect,
  renderIcon,
  selectedStageId,
  stages,
}: Omit<WorkspaceJourneyNavigationProps<Id>, "liveStageId">) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 xl:hidden dark:bg-sidebar">
      {stages.map((stage) => (
        <Button
          variant="ghost"
          size="xs"
          className={cn(
            "shrink-0 gap-1.5 rounded-full border px-2.5 py-1 disabled:opacity-100",
            selectedStageId === stage.id
              ? "border-primary/30 bg-primary/8 text-primary-text"
              : "border-border bg-background text-muted-foreground dark:bg-workspace-card",
            !stage.reachable && "opacity-45",
          )}
          disabled={!stage.reachable}
          key={stage.id}
          onClick={() => onSelect(stage.id)}
        >
          <WorkspaceJourneyStageIcon
            renderIcon={renderIcon}
            stage={stage}
          />
          {stage.label}
        </Button>
      ))}
    </div>
  );
}

export function WorkspaceSurfaceCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border/70 bg-workspace-card shadow-xs",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function WorkspaceRailSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section>
      <h3 className="px-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h3>
      <div className="mt-2 space-y-1.5">{children}</div>
    </section>
  );
}

function WorkspaceJourneyStageButton<Id extends string>({
  isLive,
  isSelected,
  onSelect,
  renderIcon,
  stage,
}: {
  isLive: boolean;
  isSelected: boolean;
  onSelect: () => void;
  renderIcon: (stage: WorkspaceJourneyStage<Id>) => ReactNode;
  stage: WorkspaceJourneyStage<Id>;
}) {
  return (
    <Button
      variant="ghost"
      aria-current={isSelected ? "step" : undefined}
      className={cn(
        "h-auto w-full items-start justify-start gap-2.5 border px-2.5 py-2.5 text-left font-normal disabled:opacity-100",
        isSelected
          ? "border-primary/25 bg-background text-foreground shadow-xs"
          : "border-transparent text-muted-foreground hover:bg-muted/70",
        !stage.reachable && "cursor-not-allowed opacity-50",
      )}
      disabled={!stage.reachable}
      onClick={onSelect}
    >
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border",
          stage.state === "completed"
            ? "border-emerald-600 bg-emerald-600 text-white dark:border-[#3ecf8e] dark:bg-[#3ecf8e] dark:text-[#0b0e14]"
            : stage.state === "blocked"
              ? "border-amber-500 bg-amber-500/10 text-amber-700 dark:border-[#f0b45a] dark:bg-[#f0b45a]/10 dark:text-[#f0b45a]"
              : isLive
                ? "border-primary bg-primary/8 text-primary-text ring-4 ring-primary/10"
                : "border-border bg-background text-muted-foreground dark:bg-workspace-card",
        )}
      >
        <WorkspaceJourneyStageIcon
          renderIcon={renderIcon}
          stage={stage}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold">{stage.label}</span>
        <span className="mt-1 block text-xs capitalize text-muted-foreground">
          {isLive
            ? stage.liveLabel ??
              (stage.state === "blocked" ? "Action required" : "Live now")
            : stage.meta ?? stage.state}
        </span>
      </span>
    </Button>
  );
}

function WorkspaceJourneyStageIcon<Id extends string>({
  renderIcon,
  stage,
}: {
  renderIcon: (stage: WorkspaceJourneyStage<Id>) => ReactNode;
  stage: WorkspaceJourneyStage<Id>;
}) {
  if (stage.state === "completed") return <Check className="size-3.5" />;
  if (stage.state === "blocked") {
    return <AlertTriangle className="size-3" />;
  }
  if (stage.state === "locked") return <LockKeyhole className="size-3" />;
  return renderIcon(stage);
}
