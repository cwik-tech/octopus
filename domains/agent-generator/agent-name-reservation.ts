import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { withFileMutationLock, writeFileAtomic } from "../../core/file-mutation.js";
import { validateExactAgentName } from "./agent-name-rules.js";

interface AgentNameReservationReceipt {
  version: 1;
  planId: string;
  jobId: string;
  name: string;
  createdAt: string;
}

export type AgentNameReservationResult =
  | { status: "reserved" }
  | { status: "reused" };

// Re-exported so every existing caller keeps one import for names and
// reservations, while policy code can take the rule alone.
export { validateExactAgentName } from "./agent-name-rules.js";

export async function reservePlannedAgentName(params: {
  repoRoot: string;
  planId: string;
  jobId: string;
  name: string;
}): Promise<AgentNameReservationResult> {
  const name = validateExactAgentName(params.name);
  return withAgentNameMutationLock(params.repoRoot, name, async () => {
    const finalPath = path.join(params.repoRoot, "agents", name);
    if (fs.existsSync(finalPath)) {
      if (ownsPublishedAgent(finalPath, params.planId, name)) {
        await removeFulfilledReservation(params.repoRoot, params.planId, name);
        return { status: "reused" };
      }
      throw new Error(`Agent name is no longer available: ${name}`);
    }

    const receiptPath = reservationPath(params.repoRoot, name);
    const existing = readReservation(receiptPath);
    if (existing) {
      if (existing.planId !== params.planId || existing.name !== name) {
        throw new Error(`Agent name is reserved by another build: ${name}`);
      }
      await writeFileAtomic(
        receiptPath,
        `${JSON.stringify({ ...existing, jobId: params.jobId })}\n`,
      );
      return { status: "reserved" };
    }

    await fs.promises.mkdir(path.dirname(receiptPath), { recursive: true });
    const receipt: AgentNameReservationReceipt = {
      version: 1,
      planId: params.planId,
      jobId: params.jobId,
      name,
      createdAt: new Date().toISOString(),
    };
    try {
      const handle = await fs.promises.open(receiptPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isFileAlreadyExistsError(error)) throw error;
      const raced = readReservation(receiptPath);
      if (!raced || raced.planId !== params.planId || raced.name !== name) {
        throw new Error(`Agent name is reserved by another build: ${name}`);
      }
    }
    return { status: "reserved" };
  });
}

export async function verifyPlannedAgentReservation(params: {
  repoRoot: string;
  planId: string;
  jobId: string;
  name: string;
}): Promise<void> {
  const receipt = readReservation(reservationPath(params.repoRoot, params.name));
  if (
    !receipt ||
    receipt.planId !== params.planId ||
    receipt.jobId !== params.jobId ||
    receipt.name !== params.name
  ) {
    throw new Error(`Agent name reservation is not owned by this build: ${params.name}`);
  }
}

export async function releasePlannedAgentReservation(params: {
  repoRoot: string;
  planId: string;
  jobId: string;
  name: string;
}): Promise<void> {
  await withAgentNameMutationLock(params.repoRoot, params.name, async () => {
    const receiptPath = reservationPath(params.repoRoot, params.name);
    const receipt = readReservation(receiptPath);
    if (!receipt) return;
    if (
      receipt.planId !== params.planId ||
      receipt.jobId !== params.jobId ||
      receipt.name !== params.name
    ) {
      throw new Error(`Cannot release another build's Agent reservation: ${params.name}`);
    }
    await fs.promises.rm(receiptPath, { force: true });
  });
}

/**
 * Gives back a reservation whose Agent this plan has already published.
 *
 * The receipt exists so two builds cannot race for one name. Once the package
 * is in `agents/` under this plan's ownership marker, the folder itself makes
 * the name unavailable and the receipt has done its job. A job that was killed
 * never removed its own, and a later job of the same plan is the only thing
 * that can — `releasePlannedAgentReservation` deliberately refuses another
 * job's receipt.
 */
export async function releaseFulfilledPlannedAgentReservation(params: {
  repoRoot: string;
  planId: string;
  name: string;
}): Promise<void> {
  await withAgentNameMutationLock(params.repoRoot, params.name, async () => {
    await removeFulfilledReservation(params.repoRoot, params.planId, params.name);
  });
}

/**
 * Removes a fulfilled reservation, with the name lock already held.
 *
 * Only a receipt that parses and names this exact plan and name is removed.
 * Another plan's evidence, and evidence this module cannot read, belong to
 * someone this build cannot speak for and are always left where they are.
 */
async function removeFulfilledReservation(
  repoRoot: string,
  planId: string,
  name: string,
): Promise<void> {
  const agentPath = path.join(repoRoot, "agents", name);
  if (!fs.existsSync(path.join(agentPath, `${name}.md`))) return;
  if (!ownsPublishedAgent(agentPath, planId, name)) return;
  const receiptPath = reservationPath(repoRoot, name);
  const receipt = readReservation(receiptPath);
  if (!receipt || receipt.planId !== planId || receipt.name !== name) return;
  await fs.promises.rm(receiptPath, { force: true });
}

export function assertAgentNameIsNotReserved(
  repoRoot: string,
  name: string,
): void {
  const receipt = readReservation(reservationPath(repoRoot, name));
  if (receipt) {
    throw new Error(`Agent name is reserved by an active build: ${name}`);
  }
}

export function withAgentNameMutationLock<T>(
  repoRoot: string,
  name: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const digest = createHash("sha256").update(name, "utf8").digest("hex");
  return withFileMutationLock(
    path.join(repoRoot, ".create-orchestrator", "name-locks", digest),
    mutate,
  );
}

function reservationPath(repoRoot: string, name: string): string {
  const digest = createHash("sha256").update(name, "utf8").digest("hex");
  return path.join(
    repoRoot,
    ".create-orchestrator",
    "agent-name-reservations",
    `${digest}.json`,
  );
}

/**
 * Reads a reservation receipt, or reports that the file is not one.
 *
 * The bytes on disk outlive the process that wrote them, so the receipt is
 * rebuilt field by field rather than believed. A file that cannot be rebuilt is
 * not a partial reservation: it is no reservation at all, which is the same
 * answer as an absent file and lets the name be claimed again.
 */
function readReservation(receiptPath: string): AgentNameReservationReceipt | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== 1) return null;
  const planId = readString(parsed.planId);
  const jobId = readString(parsed.jobId);
  const name = readString(parsed.name);
  const createdAt = readString(parsed.createdAt);
  if (planId === null || jobId === null || name === null || createdAt === null) {
    return null;
  }
  return { version: 1, planId, jobId, name, createdAt };
}

/** Whether the ownership marker in `agentPath` names this plan and name. */
function ownsPublishedAgent(
  agentPath: string,
  planId: string,
  requestedName: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(agentPath, ".create-orchestrator"), "utf8"),
    );
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  return (
    readString(parsed.orchestratorKey) === planId &&
    readString(parsed.requestedName) === requestedName
  );
}

/** Whether a write failed because the file was already there. */
function isFileAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
