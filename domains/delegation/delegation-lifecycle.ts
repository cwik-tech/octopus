import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../../core/file-mutation.js";
import type { DelegationStatusSnapshot } from "../../core/types.js";
import { appendJsonl, getAssignmentLogPath } from "../runtime/logger.js";

const DELEGATION_LIFECYCLE_LOG_FILENAME = "delegation-lifecycle.jsonl";
const DELEGATION_STATE_FILENAME = "delegation-state.json";

export interface DelegationLifecycleRecord extends DelegationStatusSnapshot {
  schemaVersion: 1;
  lastEventAt: string;
}

export function recordDelegationLifecycle(
  outputDir: string,
  snapshot: DelegationStatusSnapshot,
): DelegationLifecycleRecord {
  const record: DelegationLifecycleRecord = {
    schemaVersion: 1,
    lastEventAt: snapshot.lastEventAt ?? new Date().toISOString(),
    ...snapshot,
  };

  appendJsonl(
    getAssignmentLogPath(outputDir, DELEGATION_LIFECYCLE_LOG_FILENAME),
    record,
  );
  persistLatestDelegationState(outputDir, record);
  return record;
}

function persistLatestDelegationState(
  outputDir: string,
  record: DelegationLifecycleRecord,
): void {
  const statePath = getAssignmentLogPath(outputDir, DELEGATION_STATE_FILENAME);
  const state = readState(statePath);
  state[record.delegationId] = record;
  writeFileAtomicSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function readState(
  statePath: string,
): Record<string, DelegationLifecycleRecord> {
  if (!fs.existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<
      string,
      DelegationLifecycleRecord
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
