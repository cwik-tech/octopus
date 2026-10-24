export type ScheduleKind = "agent" | "workflow";
export type ScheduleOverlapPolicy = "skip" | "queue" | "cancel_previous";
export type OverlapPolicy = ScheduleOverlapPolicy;
export type ScheduleLastStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped_overlap"
  | "error";

export interface ScheduleModelOverride {
  readonly provider: string;
  readonly model: string;
}

export interface ScheduleProjectContextSelection {
  readonly version: 1;
  readonly includeBrief: boolean;
  readonly fileNames: string[];
}

export interface ScheduleActiveFire {
  readonly sessionId: string;
  readonly taskId: string;
  readonly firedAt: string;
}

export interface SchedulePendingFire {
  readonly sessionId: string;
  readonly firedAt: string;
}

export interface ScheduleRuntime {
  readonly nextFireAt?: string;
  readonly lastFireAt?: string;
  readonly lastStatus?: ScheduleLastStatus;
  readonly lastSessionId?: string;
  readonly lastTaskId?: string;
  readonly activeFires?: readonly ScheduleActiveFire[];
  readonly pendingFire?: SchedulePendingFire;
  readonly lastError?: string;
}

export interface ScheduleDefinition {
  readonly id: string;
  readonly name: string;
  readonly kind: ScheduleKind;
  readonly target: string;
  readonly modelOverride?: ScheduleModelOverride;
  readonly projectId?: string;
  readonly projectContext?: ScheduleProjectContextSelection;
  readonly prompt: string;
  readonly cron: string;
  readonly timezone: string;
  readonly scheduleLabel: string;
  readonly overlap: ScheduleOverlapPolicy;
  readonly notifyOnFailure: boolean;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Schedule extends ScheduleDefinition {
  readonly runtime: ScheduleRuntime;
}

export type ScheduleView = Schedule;

export interface ScheduleInput {
  readonly name: string;
  readonly kind: ScheduleKind;
  readonly target: string;
  readonly modelOverride?: ScheduleModelOverride;
  readonly projectId?: string;
  readonly projectContext?: ScheduleProjectContextSelection;
  readonly prompt: string;
  readonly cron: string;
  readonly timezone: string;
  readonly scheduleLabel: string;
  readonly overlap: ScheduleOverlapPolicy;
  readonly notifyOnFailure: boolean;
  readonly enabled?: boolean;
}

type ScheduleScalarPatch = {
  readonly [Key in keyof Omit<
    ScheduleInput,
    "modelOverride" | "projectId" | "projectContext"
  >]?: ScheduleInput[Key] | undefined;
};

export type SchedulePatch = ScheduleScalarPatch & {
  readonly modelOverride?: ScheduleModelOverride | null | undefined;
  readonly projectId?: string | null | undefined;
  readonly projectContext?: ScheduleProjectContextSelection | null | undefined;
};
