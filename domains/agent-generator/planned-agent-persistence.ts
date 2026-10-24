import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { GeneratedSkill } from "../../contracts/agent-generator.js";
import { withFileMutationLock, writeFileAtomic } from "../../core/file-mutation.js";
import { parseAgentFrontmatter } from "../../parsers/load-agent.js";
import { commitAgent } from "./commit-agent.js";
import {
  validateExactAgentName,
  withAgentNameMutationLock,
} from "./agent-name-reservation.js";

export type PlannedAgentPersistenceBoundary =
  | "after_agent_files_staged"
  | "after_agent_ready_receipt"
  | "after_agent_marker_staged"
  | "after_agent_published";

export type PlannedAgentPersistenceObserver = (
  boundary: PlannedAgentPersistenceBoundary,
) => void | Promise<void>;

interface StagedAgentReceipt {
  version: 1;
  state: "building" | "ready";
  ownerPid: number;
  createdAt: string;
  orchestratorKey: string;
  requestedName: string;
  agentName: string;
}

const activeStagedAgentTransactions = new Set<string>();

/**
 * A generated Agent package that exists privately and is ready to publish.
 *
 * Staging and publication are separate so a caller that must satisfy another
 * precondition — an unchanged Team revision, say — can hold the package back
 * until that precondition still holds, rather than leaving an Agent nobody
 * authorized behind after a lost race.
 */
export interface StagedPlannedAgent {
  agentName: string;
  /** Absolute path of the staged package, absent once already published. */
  stagedAgentPath: string | null;
  transactionRoot: string | null;
  alreadyPublished: boolean;
}

/** Stage a generated Agent privately and atomically publish its exact name. */
export async function persistPlannedAgentDraft(params: {
  repoRoot: string;
  orchestratorKey: string;
  requestedName: string;
  personaMarkdown: string;
  generatedSkills: GeneratedSkill[];
  onPersistenceBoundary?: PlannedAgentPersistenceObserver;
}): Promise<string> {
  const staged = await stagePlannedAgentDraft(params);
  return publishStagedPlannedAgent(params.repoRoot, staged, params.onPersistenceBoundary);
}

/**
 * Discards a staged transaction this orchestrator owns.
 *
 * Only a transaction whose receipt names this exact plan and Agent is removed,
 * and only from inside the staging root, so foreign or unrecognized evidence is
 * always preserved. Returns whether anything was discarded.
 */
export async function discardStagedPlannedAgent(params: {
  repoRoot: string;
  orchestratorKey: string;
  requestedName: string;
  transactionRoot: string;
}): Promise<boolean> {
  const stagingRoot = stagedAgentsRoot(params.repoRoot);
  const resolved = path.resolve(params.transactionRoot);
  const relative = path.relative(path.resolve(stagingRoot), resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing to discard a transaction outside the staging root: ${params.transactionRoot}`,
    );
  }
  const receipt = readStagedAgentReceipt(path.join(resolved, "receipt.json"));
  if (receipt === "absent" || receipt === "invalid") return false;
  // The caller is discarding a completed package it owns. Anything still
  // building, or naming a different Agent, is evidence about something else
  // and is preserved rather than removed on a partial name match.
  if (
    receipt.state !== "ready" ||
    receipt.orchestratorKey !== params.orchestratorKey ||
    receipt.requestedName !== params.requestedName ||
    receipt.agentName !== params.requestedName
  ) {
    return false;
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
  await removeEmptyStagedAgentsRoot(params.repoRoot);
  return true;
}

/** Publish a package staged earlier, or report one already published. */
export async function publishStagedPlannedAgent(
  repoRoot: string,
  staged: StagedPlannedAgent,
  onPersistenceBoundary?: PlannedAgentPersistenceObserver,
): Promise<string> {
  if (staged.alreadyPublished || !staged.transactionRoot) return staged.agentName;
  const receipt = readStagedAgentReceipt(
    path.join(staged.transactionRoot, "receipt.json"),
  );
  if (
    receipt === "absent" ||
    receipt === "invalid" ||
    receipt.agentName !== staged.agentName
  ) {
    throw new Error(`Staged Agent is no longer available: ${staged.agentName}`);
  }
  await publishStagedAgent(repoRoot, staged.transactionRoot, receipt);
  await onPersistenceBoundary?.("after_agent_published");
  return staged.agentName;
}

/** Produce the package privately, stopping before it reaches `agents/`. */
export async function stagePlannedAgentDraft(params: {
  repoRoot: string;
  orchestratorKey: string;
  requestedName: string;
  personaMarkdown: string;
  generatedSkills: GeneratedSkill[];
  onPersistenceBoundary?: PlannedAgentPersistenceObserver;
}): Promise<StagedPlannedAgent> {
  const lockPath = stagedAgentLockPath(params.repoRoot, params.requestedName);
  await removeAbandonedStagedAgentTransactions(params.repoRoot);
  return withFileMutationLock(lockPath, async () => {
    const existing = findOrchestratorAgent(
      params.repoRoot,
      params.orchestratorKey,
      params.requestedName,
    );
    if (existing) {
      return {
        agentName: existing,
        stagedAgentPath: null,
        transactionRoot: null,
        alreadyPublished: true,
      };
    }

    const recovered = findReadyStagedAgent(params);
    if (recovered) {
      if (recovered.restoreMarker) {
        await writeAgentOwnershipMarker(
          recovered.restoreMarker.stagedAgentPath,
          recovered.restoreMarker.receipt,
        );
        await params.onPersistenceBoundary?.("after_agent_marker_staged");
      }
      return recovered.staged;
    }

    const agentName = validateExactAgentName(params.requestedName);
    const finalAgentPath = path.join(params.repoRoot, "agents", agentName);
    if (fs.existsSync(finalAgentPath)) {
      throw new Error(`Agent folder already exists: ${finalAgentPath}`);
    }
    const transactionRoot = path.join(
      stagedAgentsRoot(params.repoRoot),
      crypto.randomUUID(),
    );
    const stagingRepoRoot = path.join(transactionRoot, "repo");
    const receiptPath = path.join(transactionRoot, "receipt.json");
    const buildingReceipt: StagedAgentReceipt = {
      version: 1,
      state: "building",
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      orchestratorKey: params.orchestratorKey,
      requestedName: params.requestedName,
      agentName,
    };
    activeStagedAgentTransactions.add(transactionRoot);
    try {
      await writeReceipt(receiptPath, buildingReceipt);
      await commitAgent({
        repoRoot: stagingRepoRoot,
        approvedName: agentName,
        personaMarkdown: params.personaMarkdown,
        skillPaths: [],
        generatedSkills: params.generatedSkills,
      });
      await params.onPersistenceBoundary?.("after_agent_files_staged");

      // The marker is written first so that `ready` is the last thing to
      // appear and therefore means the package is complete. A ready receipt
      // beside a missing marker would otherwise be indistinguishable from a
      // package whose ownership was never established.
      await writeAgentOwnershipMarker(
        path.join(stagingRepoRoot, "agents", agentName),
        buildingReceipt,
      );
      await params.onPersistenceBoundary?.("after_agent_marker_staged");
      await writeReceipt(receiptPath, { ...buildingReceipt, state: "ready" });
      await params.onPersistenceBoundary?.("after_agent_ready_receipt");

      return {
        agentName,
        stagedAgentPath: path.join(stagingRepoRoot, "agents", agentName),
        transactionRoot,
        alreadyPublished: false,
      };
    } finally {
      activeStagedAgentTransactions.delete(transactionRoot);
    }
  });
}

/**
 * Whether this orchestrator still holds a publishable package for one name.
 *
 * A ready package is work a retry of the same plan can finish, so its name has
 * to stay with it: handing the name back while the package is on disk would
 * let a different plan claim the exact name that package carries. The answer is
 * about one name only. A transaction whose receipt cannot be read names nobody,
 * so it holds no name — refusing it is `stagePlannedAgentDraft`'s job, and
 * answering `true` for every name because of it would make one unreadable
 * directory freeze every name in the plan. A receipt that names this Agent but
 * has no intact package behind it is not work anyone can take over either.
 */
export function hasReadyStagedPlannedAgent(params: {
  repoRoot: string;
  orchestratorKey: string;
  requestedName: string;
}): boolean {
  for (const { transactionRoot, receipt } of readableStagedAgentTransactions(
    params.repoRoot,
  )) {
    if (
      receipt.state !== "ready" ||
      receipt.orchestratorKey !== params.orchestratorKey ||
      receipt.requestedName !== params.requestedName
    ) {
      continue;
    }
    if (inspectStagedPackage(transactionRoot, receipt).status === "intact") return true;
  }
  return false;
}

/**
 * Staged transactions whose receipts can be read, without changing anything.
 *
 * `readStagedAgentTransactions` is the staging path's view: it removes
 * abandoned shells and refuses evidence it cannot understand, because staging
 * is about to write. A query must do neither.
 */
function readableStagedAgentTransactions(repoRoot: string): Array<{
  transactionRoot: string;
  receipt: StagedAgentReceipt;
}> {
  const root = stagedAgentsRoot(repoRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    // Only a staging root that is not there means nothing is staged. Anything
    // else — a permission fault, a path that is not a directory, an I/O error —
    // is a question this query could not answer, and answering "nothing" would
    // hand back names whose packages may be sitting right there.
    if (isMissingFileError(error)) return [];
    throw error;
  }
  const transactions: Array<{
    transactionRoot: string;
    receipt: StagedAgentReceipt;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = path.join(root, entry.name);
    if (activeStagedAgentTransactions.has(transactionRoot)) continue;
    const receipt = readStagedAgentReceipt(path.join(transactionRoot, "receipt.json"));
    if (receipt === "absent" || receipt === "invalid") continue;
    transactions.push({ transactionRoot, receipt });
  }
  return transactions;
}

/**
 * Whether a ready transaction really holds the package its receipt claims.
 *
 * The checks are the same wherever they are applied: the persona has to be
 * there, it has to name the Agent the receipt names, and any ownership marker
 * has to belong to this build. Only the response differs — staging refuses,
 * a query answers. Nothing here reads as a side effect or writes anything, so
 * a missing marker is reported rather than restored.
 */
type StagedPackageInspection =
  | { status: "intact"; stagedAgentPath: string; markerMissing: boolean }
  | { status: "invalid"; reason: string };

function inspectStagedPackage(
  transactionRoot: string,
  receipt: StagedAgentReceipt,
): StagedPackageInspection {
  const stagedAgentPath = path.join(
    transactionRoot,
    "repo",
    "agents",
    receipt.agentName,
  );
  // A matching ready receipt is a committed claim on this name. If the package
  // it names is gone, that is broken durable evidence, not an invitation to
  // open a second transaction for the same Agent.
  const personaPath = path.join(stagedAgentPath, `${receipt.agentName}.md`);
  if (!fs.existsSync(personaPath)) {
    return {
      status: "invalid",
      reason: `Staged agent transaction is ready but its package is missing: ${transactionRoot}`,
    };
  }
  // Checked for every ready package, not only when a marker is missing: the
  // marker proves who owns the package, never that its content is the Agent
  // the receipt names.
  let declared: string | undefined;
  try {
    declared = parseAgentFrontmatter(personaPath).frontmatter.name?.trim();
  } catch (error) {
    return {
      status: "invalid",
      reason: `Staged agent persona could not be read at ${transactionRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (declared !== receipt.agentName) {
    return {
      status: "invalid",
      reason: `Staged agent persona does not name ${receipt.agentName}: found ${declared ?? "no name"}`,
    };
  }
  const marker = readAgentOwnershipMarker(stagedAgentPath);
  if (marker === "invalid") {
    return {
      status: "invalid",
      reason: `Staged agent carries an unreadable ownership marker: ${receipt.agentName}`,
    };
  }
  if (marker !== "absent" && !sameAgentOwnership(marker, receipt)) {
    return {
      status: "invalid",
      reason: `Staged agent ownership does not match: ${receipt.agentName}`,
    };
  }
  return { status: "intact", stagedAgentPath, markerMissing: marker === "absent" };
}

/** A package this orchestrator already staged and can still publish. */
function findReadyStagedAgent(params: {
  repoRoot: string;
  orchestratorKey: string;
  requestedName: string;
}): {
  staged: StagedPlannedAgent;
  restoreMarker: { stagedAgentPath: string; receipt: StagedAgentReceipt } | null;
} | null {
  let restoreMarker: { stagedAgentPath: string; receipt: StagedAgentReceipt } | null = null;
  for (const staged of readStagedAgentTransactions(params.repoRoot)) {
    const { receipt, transactionRoot } = staged;
    if (
      receipt.state !== "ready" ||
      receipt.orchestratorKey !== params.orchestratorKey ||
      receipt.requestedName !== params.requestedName
    ) {
      continue;
    }
    const inspection = inspectStagedPackage(transactionRoot, receipt);
    if (inspection.status === "invalid") throw new Error(inspection.reason);
    // A marker that names another build is a claim this process cannot
    // override, and the inspection above has already refused it. A missing one
    // is different: the receipt this transaction owns already says the package
    // is complete and its persona proves it, so the marker is restored rather
    // than treated as unknowable. Receipts written by an earlier ordering,
    // where `ready` preceded the marker, are recovered by exactly this path.
    if (inspection.markerMissing) {
      restoreMarker = { stagedAgentPath: inspection.stagedAgentPath, receipt };
    }
    return {
      staged: {
        agentName: receipt.agentName,
        stagedAgentPath: inspection.stagedAgentPath,
        transactionRoot,
        alreadyPublished: false,
      },
      restoreMarker,
    };
  }
  return null;
}

async function publishStagedAgent(
  repoRoot: string,
  transactionRoot: string,
  receipt: StagedAgentReceipt,
): Promise<void> {
  await withAgentNameMutationLock(repoRoot, receipt.agentName, async () => {
    const agentsRoot = path.join(repoRoot, "agents");
    const stagedAgentPath = path.join(
      transactionRoot,
      "repo",
      "agents",
      receipt.agentName,
    );
    const finalAgentPath = path.join(agentsRoot, receipt.agentName);
    await fs.promises.mkdir(agentsRoot, { recursive: true });
    try {
      await fs.promises.rename(stagedAgentPath, finalAgentPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "ENOENT") {
        throw error;
      }
      const marker = readAgentOwnershipMarker(finalAgentPath);
      if (
        marker === "absent" ||
        marker === "invalid" ||
        !sameAgentOwnership(marker, receipt) ||
        !fs.existsSync(path.join(finalAgentPath, `${receipt.agentName}.md`))
      ) {
        throw new Error(`Agent folder already exists: ${finalAgentPath}`);
      }
    }
  });
  await fs.promises.rm(transactionRoot, { recursive: true, force: true });
  await removeEmptyStagedAgentsRoot(repoRoot);
}

function readStagedAgentTransactions(repoRoot: string): Array<{
  transactionRoot: string;
  receipt: StagedAgentReceipt;
}> {
  const root = stagedAgentsRoot(repoRoot);
  if (!fs.existsSync(root)) return [];
  const transactions: Array<{
    transactionRoot: string;
    receipt: StagedAgentReceipt;
  }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = path.join(root, entry.name);
    // A transaction this process is still creating has no receipt yet, because
    // `writeFileAtomic` makes the directory before renaming the file into it.
    if (activeStagedAgentTransactions.has(transactionRoot)) continue;
    const receipt = readStagedAgentReceipt(path.join(transactionRoot, "receipt.json"));
    if (receipt === "absent") {
      // No receipt and no owner. An empty shell is discarded outright; anything
      // with content is staged payload whose ownership cannot be guessed.
      if (isEmptyDirectory(transactionRoot)) {
        fs.rmSync(transactionRoot, { recursive: true, force: true });
        continue;
      }
      throw new Error(
        `Staged agent transaction holds payload with no receipt: ${transactionRoot}`,
      );
    }
    if (receipt === "invalid") {
      throw new Error(
        `Staged agent transaction holds unreadable durable evidence: ${transactionRoot}`,
      );
    }
    transactions.push({ transactionRoot, receipt });
  }
  return transactions;
}

/** Whether a filesystem error means the entry simply is not there. */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isEmptyDirectory(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

function readStagedAgentReceipt(
  receiptPath: string,
): StagedAgentReceipt | "absent" | "invalid" {
  let source: string;
  try {
    source = fs.readFileSync(receiptPath, "utf8");
  } catch (error) {
    return isMissingFileError(error) ? "absent" : "invalid";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return "invalid";
  }
  return parseStagedAgentReceipt(parsed) ?? "invalid";
}

/** Builds a receipt from unknown JSON, or reports that it is not one. */
function parseStagedAgentReceipt(value: unknown): StagedAgentReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = { ...value };
  const ownerPid = record.ownerPid;
  const agentName = record.agentName;
  if (record.version !== 1) return null;
  if (record.state !== "building" && record.state !== "ready") return null;
  if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    return null;
  }
  if (typeof record.createdAt !== "string") return null;
  if (typeof record.orchestratorKey !== "string") return null;
  const requestedName = record.requestedName;
  if (typeof requestedName !== "string" || !isSafeAgentName(requestedName)) return null;
  if (typeof agentName !== "string" || !isSafeAgentName(agentName)) return null;
  // Every receipt this module writes names the Agent it was asked for. A
  // receipt where the two disagree could otherwise publish one Agent under
  // another's request.
  if (requestedName !== agentName) return null;
  return {
    version: 1,
    state: record.state,
    ownerPid,
    createdAt: record.createdAt,
    orchestratorKey: record.orchestratorKey,
    requestedName,
    agentName,
  };
}

async function writeReceipt(
  receiptPath: string,
  receipt: StagedAgentReceipt,
): Promise<void> {
  await writeFileAtomic(receiptPath, `${JSON.stringify(receipt)}\n`);
}

async function writeAgentOwnershipMarker(
  agentPath: string,
  receipt: Pick<StagedAgentReceipt, "orchestratorKey" | "requestedName">,
): Promise<void> {
  await writeFileAtomic(
    path.join(agentPath, ".create-orchestrator"),
    `${JSON.stringify({
      orchestratorKey: receipt.orchestratorKey,
      requestedName: receipt.requestedName,
    })}\n`,
  );
}

async function removeAbandonedStagedAgentTransactions(repoRoot: string): Promise<void> {
  for (const { transactionRoot, receipt } of readStagedAgentTransactions(repoRoot)) {
    if (
      receipt.state !== "building" ||
      activeStagedAgentTransactions.has(transactionRoot)
    ) {
      continue;
    }
    if (receipt.ownerPid === process.pid || !isProcessAlive(receipt.ownerPid)) {
      await fs.promises.rm(transactionRoot, { recursive: true, force: true });
    }
  }
  await removeEmptyStagedAgentsRoot(repoRoot);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeEmptyStagedAgentsRoot(repoRoot: string): Promise<void> {
  await fs.promises.rmdir(stagedAgentsRoot(repoRoot)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
    },
  );
}

function readAgentOwnershipMarker(
  agentPath: string,
): { orchestratorKey: string; requestedName: string } | "absent" | "invalid" {
  let source: string;
  try {
    source = fs.readFileSync(path.join(agentPath, ".create-orchestrator"), "utf8");
  } catch (error) {
    // Only a missing marker may be reconstructed. Anything else is a marker
    // this process cannot read, and overwriting it would invent ownership.
    return isMissingFileError(error) ? "absent" : "invalid";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return "invalid";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "invalid";
  }
  const marker: Record<string, unknown> = { ...parsed };
  return typeof marker.orchestratorKey === "string" &&
    typeof marker.requestedName === "string"
    ? {
        orchestratorKey: marker.orchestratorKey,
        requestedName: marker.requestedName,
      }
    : "invalid";
}

function sameAgentOwnership(
  left: Pick<StagedAgentReceipt, "orchestratorKey" | "requestedName">,
  right: Pick<StagedAgentReceipt, "orchestratorKey" | "requestedName">,
): boolean {
  return left.orchestratorKey === right.orchestratorKey &&
    left.requestedName === right.requestedName;
}

function stagedAgentsRoot(repoRoot: string): string {
  return path.join(repoRoot, ".create-orchestrator", "staged-agents");
}

function stagedAgentLockPath(repoRoot: string, requestedName: string): string {
  const digest = crypto.createHash("sha256").update(requestedName).digest("hex");
  return path.join(stagedAgentsRoot(repoRoot), `.lock-${digest}`);
}

function isSafeAgentName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
}

function findOrchestratorAgent(
  repoRoot: string,
  orchestratorKey: string,
  requestedName: string,
): string | null {
  const agentPath = path.join(repoRoot, "agents", requestedName);
  const marker = readAgentOwnershipMarker(agentPath);
  if (marker === "absent" || marker === "invalid") return null;
  return marker.orchestratorKey === orchestratorKey &&
      marker.requestedName === requestedName &&
      fs.existsSync(path.join(agentPath, `${requestedName}.md`))
    ? requestedName
    : null;
}
