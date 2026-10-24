import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RunPlan } from "../../contracts/run-plan.js";
import type { WorkspaceProjectContextSnapshot } from "../../contracts/projects.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  isSafePathSegment,
  resolveExistingPathInside,
} from "../../core/path-safety.js";
import type { SessionRunAssignmentLocation } from "../run/run-location.js";
import type { McpWorkflowResolutionSnapshot } from "../mcp/mcp-workflow-preflight.js";
import type {
  McpResourceImportManifest,
  McpResourceStoredSnapshot,
} from "../mcp/mcp-resource-import-store.js";

export interface PreparedSessionRunStorage {
  location: SessionRunAssignmentLocation;
  inputSnapshotPath: string;
  workflowSnapshotPath?: string;
  mcpResolutionPath?: string;
}

export interface CapturedWorkspaceProjectContext {
  projectId: string;
  projectUpdatedAt: string;
  capturedAt: string;
  brief?: Buffer;
  files: Array<{
    name: string;
    contents: Buffer;
    mimeType?: string;
  }>;
}

export interface McpResourceSnapshotSource {
  selectProvenance(
    sessionId: string,
    materializedInputFilenames: readonly string[],
  ): Promise<readonly McpResourceImportManifest[]>;
  readSnapshot(
    sessionId: string,
    snapshotId: string,
  ): Promise<McpResourceStoredSnapshot>;
}

export interface PrepareSessionRunStorageInput {
  sessionId: string;
  taskId: string;
  runId: string;
  assignmentId: string;
  workflowId: string;
  workflowYaml?: string;
  mcpResolution?: McpWorkflowResolutionSnapshot;
  runPlanId?: string;
  runPlan?: RunPlan;
  createdAt: string;
  location: SessionRunAssignmentLocation;
  sessionPath: string;
  sourceInputsDir: string;
  mcpResourceSnapshots: McpResourceSnapshotSource;
  projectContext?: CapturedWorkspaceProjectContext;
}

interface InputSnapshotFile {
  uploadedAt?: string;
  path: string;
  kind: "input" | "parsed";
  bytes: number;
  sha256: string;
}

interface SkippedInputSnapshotEntry {
  path: string;
  reason: "symbolic_link" | "unsupported_file_type";
}

export async function prepareSessionRunStorage(
  params: PrepareSessionRunStorageInput,
): Promise<PreparedSessionRunStorage> {
  if (existsSync(params.location.runPath)) {
    throw new Error(`Run storage already exists: ${params.runId}`);
  }

  const runsDir = path.dirname(params.location.runPath);
  await fs.mkdir(runsDir, { recursive: true });
  if (!resolveExistingPathInside(params.sessionPath, runsDir)) {
    throw new Error("Run path must stay inside the session");
  }

  const stagingRunPath = path.join(
    runsDir,
    `.${params.runId}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const stagingAssignmentPath = path.join(
    stagingRunPath,
    "assignments",
    params.assignmentId,
  );
  const stagingSnapshotPath = path.join(stagingRunPath, "input-snapshot");
  const workflowContents = params.workflowYaml === undefined
    ? null
    : Buffer.from(params.workflowYaml, "utf8");
  const runPlanContents = params.runPlan === undefined
    ? null
    : Buffer.from(`${JSON.stringify(params.runPlan, null, 2)}\n`, "utf8");
  const mcpResolutionContents = params.mcpResolution === undefined
    ? null
    : Buffer.from(
        `${JSON.stringify(params.mcpResolution, null, 2)}\n`,
        "utf8",
      );
  let published = false;

  try {
    await fs.mkdir(stagingAssignmentPath, { recursive: true, mode: 0o700 });
    if (
      existsSync(params.sourceInputsDir) &&
      !resolveExistingPathInside(params.sessionPath, params.sourceInputsDir)
    ) {
      throw new Error("Session inputs path must stay inside the session");
    }
    const snapshot = await copySessionInputsSnapshot(
      params.sourceInputsDir,
      stagingSnapshotPath,
    );
    const mcpResourceEvidence = await prepareMcpResourceEvidence({
      sessionId: params.sessionId,
      runId: params.runId,
      assignmentId: params.assignmentId,
      createdAt: params.createdAt,
      snapshotFiles: snapshot.files,
      stagingAssignmentPath,
      stagingSnapshotPath,
      mcpResourceSnapshots: params.mcpResourceSnapshots,
    });
    const projectContext = params.projectContext
      ? await prepareWorkspaceProjectContextSnapshot(
          stagingSnapshotPath,
          params.projectContext,
        )
      : undefined;

    const workflow = workflowContents
      ? {
          path: "../workflow.yaml",
          bytes: workflowContents.byteLength,
          sha256: sha256(workflowContents),
        }
      : undefined;
    if (workflowContents) {
      await writeFileAtomic(
        path.join(stagingRunPath, "workflow.yaml"),
        workflowContents,
      );
    }
    const runPlan = runPlanContents
      ? {
          path: "../run-plan.json",
          bytes: runPlanContents.byteLength,
          sha256: sha256(runPlanContents),
        }
      : undefined;
    if (runPlanContents) {
      await writeFileAtomic(
        path.join(stagingRunPath, "run-plan.json"),
        runPlanContents,
      );
    }
    const mcpResolution = mcpResolutionContents
      ? {
          path: "../mcp-resolution.json",
          bytes: mcpResolutionContents.byteLength,
          sha256: sha256(mcpResolutionContents),
        }
      : undefined;
    if (mcpResolutionContents) {
      await writeFileAtomic(
        path.join(stagingRunPath, "mcp-resolution.json"),
        mcpResolutionContents,
      );
    }

    await writeJsonAtomic(path.join(stagingSnapshotPath, "manifest.json"), {
      version: 1,
      sessionId: params.sessionId,
      runId: params.runId,
      assignmentId: params.assignmentId,
      createdAt: params.createdAt,
      files: snapshot.files,
      skipped: snapshot.skipped,
      mcpProvenance: mcpResourceEvidence.provenance,
      ...(workflow ? { workflow } : {}),
      ...(runPlan ? { runPlan } : {}),
      ...(mcpResolution ? { mcpResolution } : {}),
      ...(projectContext
        ? {
            projectContext: {
              path: "project-context/manifest.json",
              bytes: projectContext.manifestBytes,
              sha256: projectContext.manifestSha256,
            },
          }
        : {}),
    });
    await writeJsonAtomic(path.join(stagingRunPath, "run.json"), {
      version: 1,
      id: params.runId,
      sessionId: params.sessionId,
      taskId: params.taskId,
      rootAssignmentId: params.assignmentId,
      workflowId: params.workflowId,
      createdAt: params.createdAt,
      ...((params.runPlan?.id ?? params.runPlanId)
        ? { runPlanId: params.runPlan?.id ?? params.runPlanId }
        : {}),
      paths: {
        assignment: `assignments/${params.assignmentId}`,
        inputSnapshot: "input-snapshot",
        inputSnapshotManifest: "input-snapshot/manifest.json",
        workflow: workflow ? "workflow.yaml" : null,
        runPlan: runPlan ? "run-plan.json" : null,
        mcpResolution: mcpResolution ? "mcp-resolution.json" : null,
        mcpProvenance: "input-snapshot/mcp-provenance.json",
        mcpResourceEvidence: mcpResourceEvidence.evidenceRoot,
        projectContext: projectContext
          ? "input-snapshot/project-context/manifest.json"
          : null,
      },
    });

    await fs.rename(stagingRunPath, params.location.runPath);
    published = true;
    await sealRunSnapshotReadOnly(params.location.runPath);
    if (mcpResourceEvidence.evidenceRoot) {
      await sealTreeReadOnly(
        path.join(
          params.location.runPath,
          ...mcpResourceEvidence.evidenceRoot.split("/"),
        ),
      );
    }
    await syncDirectory(runsDir);
  } catch (error) {
    if (published) {
      await makeRunSnapshotWritable(params.location.runPath);
      await fs.rm(params.location.runPath, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await fs.rm(stagingRunPath, { recursive: true, force: true });
  }

  return {
    location: params.location,
    inputSnapshotPath: path.join(params.location.runPath, "input-snapshot"),
    ...(workflowContents
      ? {
          workflowSnapshotPath: path.join(
            params.location.runPath,
            "workflow.yaml",
          ),
        }
      : {}),
    ...(mcpResolutionContents
      ? {
          mcpResolutionPath: path.join(
            params.location.runPath,
            "mcp-resolution.json",
          ),
        }
      : {}),
  };
}

async function prepareWorkspaceProjectContextSnapshot(
  snapshotRoot: string,
  context: CapturedWorkspaceProjectContext,
): Promise<{ manifestBytes: number; manifestSha256: string }> {
  const contextRoot = path.join(snapshotRoot, "project-context");
  await fs.mkdir(path.join(contextRoot, "files"), {
    recursive: true,
    mode: 0o700,
  });
  const brief = context.brief
    ? {
        relativePath: "brief.md",
        sha256: sha256(context.brief),
        byteLength: context.brief.byteLength,
      }
    : undefined;
  if (context.brief) {
    await writeFileAtomic(path.join(contextRoot, "brief.md"), context.brief);
  }
  const files = [];
  for (const file of context.files) {
    if (!isSafePathSegment(file.name)) {
      throw new Error(`Project context filename is unsafe: ${file.name}`);
    }
    await writeFileAtomic(path.join(contextRoot, "files", file.name), file.contents);
    files.push({
      name: file.name,
      relativePath: `files/${file.name}`,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      sha256: sha256(file.contents),
      byteLength: file.contents.byteLength,
    });
  }
  const manifest: WorkspaceProjectContextSnapshot = {
    version: 1,
    projectId: context.projectId,
    projectUpdatedAt: context.projectUpdatedAt,
    capturedAt: context.capturedAt,
    ...(brief ? { brief } : {}),
    files,
  };
  const manifestContents = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFileAtomic(path.join(contextRoot, "manifest.json"), manifestContents);
  return {
    manifestBytes: manifestContents.byteLength,
    manifestSha256: sha256(manifestContents),
  };
}

async function prepareMcpResourceEvidence(params: {
  sessionId: string;
  runId: string;
  assignmentId: string;
  createdAt: string;
  snapshotFiles: readonly InputSnapshotFile[];
  stagingAssignmentPath: string;
  stagingSnapshotPath: string;
  mcpResourceSnapshots: McpResourceSnapshotSource;
}): Promise<{
  provenance: {
    path: string;
    bytes: number;
    sha256: string;
    snapshotCount: number;
  };
  evidenceRoot: string | null;
}> {
  const inputFilenames = params.snapshotFiles
    .filter((file) => file.kind === "input" && file.path.startsWith("files/"))
    .map((file) => file.path.slice("files/".length));
  const selected = await params.mcpResourceSnapshots.selectProvenance(
    params.sessionId,
    inputFilenames,
  );
  const archives = await Promise.all(
    selected.map((manifest) =>
      params.mcpResourceSnapshots.readSnapshot(
        params.sessionId,
        manifest.snapshotId,
      ),
    ),
  );
  assertSnapshotSelection(selected, archives);

  const provenanceContents = Buffer.from(
    `${JSON.stringify({
      version: 1,
      sessionId: params.sessionId,
      runId: params.runId,
      assignmentId: params.assignmentId,
      capturedAt: params.createdAt,
      snapshots: selected,
    }, null, 2)}\n`,
    "utf8",
  );
  const provenancePath = path.join(
    params.stagingSnapshotPath,
    "mcp-provenance.json",
  );
  await writeFileAtomic(provenancePath, provenanceContents);

  if (archives.length > 0) {
    const evidencePath = path.join(
      params.stagingAssignmentPath,
      "evidence",
      "mcp",
      "resources",
    );
    await fs.mkdir(evidencePath, { recursive: true, mode: 0o700 });
    await fs.chmod(evidencePath, 0o700);
    for (const archive of archives) {
      await copyMcpResourceEvidenceArchive(evidencePath, archive);
    }
  }

  return {
    provenance: {
      path: "mcp-provenance.json",
      bytes: provenanceContents.byteLength,
      sha256: sha256(provenanceContents),
      snapshotCount: selected.length,
    },
    evidenceRoot: archives.length > 0
      ? `assignments/${params.assignmentId}/evidence/mcp/resources`
      : null,
  };
}

async function copySessionInputsSnapshot(
  sourceInputsDir: string,
  snapshotPath: string,
): Promise<{
  files: InputSnapshotFile[];
  skipped: SkippedInputSnapshotEntry[];
}> {
  const files: InputSnapshotFile[] = [];
  const skipped: SkippedInputSnapshotEntry[] = [];
  const filesPath = path.join(snapshotPath, "files");
  const parsedPath = path.join(snapshotPath, "parsed");
  await Promise.all([
    fs.mkdir(filesPath, { recursive: true, mode: 0o700 }),
    fs.mkdir(parsedPath, { recursive: true, mode: 0o700 }),
  ]);

  if (!existsSync(sourceInputsDir)) return { files, skipped };
  const inputEntries = await fs.readdir(sourceInputsDir, {
    withFileTypes: true,
  });
  inputEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of inputEntries) {
    const sourcePath = path.join(sourceInputsDir, entry.name);
    const snapshotRelativePath = entry.name === "parsed"
      ? "parsed"
      : path.posix.join("files", entry.name);
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      skipped.push({ path: snapshotRelativePath, reason: "symbolic_link" });
      continue;
    }

    if (entry.name === "parsed" && stat.isDirectory()) {
      await copySnapshotDirectory({
        sourceRoot: sourceInputsDir,
        sourcePath,
        targetPath: parsedPath,
        snapshotPath,
        kind: "parsed",
        files,
        skipped,
      });
      continue;
    }
    if (stat.isFile()) {
      await copySnapshotFile({
        sourceRoot: sourceInputsDir,
        sourcePath,
        targetPath: path.join(filesPath, entry.name),
        snapshotPath,
        kind: "input",
        files,
      });
      continue;
    }
    skipped.push({
      path: snapshotRelativePath,
      reason: "unsupported_file_type",
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  skipped.sort((left, right) => left.path.localeCompare(right.path));
  return { files, skipped };
}

async function copySnapshotDirectory(params: {
  sourceRoot: string;
  sourcePath: string;
  targetPath: string;
  snapshotPath: string;
  kind: InputSnapshotFile["kind"];
  files: InputSnapshotFile[];
  skipped: SkippedInputSnapshotEntry[];
}): Promise<void> {
  await fs.mkdir(params.targetPath, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(params.sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = path.join(params.sourcePath, entry.name);
    const targetPath = path.join(params.targetPath, entry.name);
    const relativeTarget = toPosixPath(
      path.relative(params.snapshotPath, targetPath),
    );
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      params.skipped.push({
        path: relativeTarget,
        reason: "symbolic_link",
      });
      continue;
    }
    if (stat.isDirectory()) {
      await copySnapshotDirectory({
        ...params,
        sourcePath,
        targetPath,
      });
      continue;
    }
    if (stat.isFile()) {
      await copySnapshotFile({
        sourceRoot: params.sourceRoot,
        sourcePath,
        targetPath,
        snapshotPath: params.snapshotPath,
        kind: params.kind,
        files: params.files,
      });
      continue;
    }
    params.skipped.push({
      path: relativeTarget,
      reason: "unsupported_file_type",
    });
  }
}

async function copySnapshotFile(params: {
  sourceRoot: string;
  sourcePath: string;
  targetPath: string;
  snapshotPath: string;
  kind: InputSnapshotFile["kind"];
  files: InputSnapshotFile[];
}): Promise<void> {
  if (!resolveExistingPathInside(params.sourceRoot, params.sourcePath)) {
    throw new Error("Snapshot source path must stay inside session inputs");
  }
  await fs.mkdir(path.dirname(params.targetPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.copyFile(params.sourcePath, params.targetPath);
  await fs.chmod(params.targetPath, 0o600);
  const contents = await fs.readFile(params.targetPath);
  const sourceStat = await fs.stat(params.sourcePath);
  params.files.push({
    ...(params.kind === 'input' ? { uploadedAt: sourceStat.mtime.toISOString() } : {}),
    path: toPosixPath(path.relative(params.snapshotPath, params.targetPath)),
    kind: params.kind,
    bytes: contents.byteLength,
    sha256: sha256(contents),
  });
}

function assertSnapshotSelection(
  selected: readonly McpResourceImportManifest[],
  archives: readonly McpResourceStoredSnapshot[],
): void {
  if (
    selected.length !== archives.length ||
    selected.some(
      (manifest, index) =>
        archives[index]?.manifest.snapshotId !== manifest.snapshotId ||
        JSON.stringify(archives[index]?.manifest) !== JSON.stringify(manifest),
    )
  ) {
    throw new Error(
      "MCP resource snapshot changed while preparing run evidence",
    );
  }
}

async function copyMcpResourceEvidenceArchive(
  evidenceRoot: string,
  archive: McpResourceStoredSnapshot,
): Promise<void> {
  const snapshotPath = path.join(evidenceRoot, archive.manifest.snapshotId);
  const contentsPath = path.join(snapshotPath, "contents");
  await fs.mkdir(contentsPath, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.chmod(snapshotPath, 0o700),
    fs.chmod(contentsPath, 0o700),
  ]);

  const manifestContents = Buffer.from(
    `${JSON.stringify(archive.manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFileAtomic(
    path.join(snapshotPath, "manifest.json"),
    manifestContents,
  );
  for (const content of archive.contents) {
    const targetPath = path.join(
      snapshotPath,
      ...content.storedPath.split("/"),
    );
    await writeFileAtomic(targetPath, content.buffer);
    await fs.chmod(targetPath, 0o400);
  }
  await fs.chmod(path.join(snapshotPath, "manifest.json"), 0o400);
}

function sha256(contents: Uint8Array): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function sealRunSnapshotReadOnly(runPath: string): Promise<void> {
  await sealTreeReadOnly(path.join(runPath, "input-snapshot"));
  for (const filename of [
    "run.json",
    "workflow.yaml",
    "run-plan.json",
    "mcp-resolution.json",
  ]) {
    const filePath = path.join(runPath, filename);
    const stat = await fs.lstat(filePath).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Run snapshot file is not regular: ${filename}`);
    }
    await fs.chmod(filePath, 0o400);
  }
}

async function sealTreeReadOnly(directoryPath: string): Promise<void> {
  const directoryStat = await fs.lstat(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Run snapshot directory must be a regular directory");
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error("Run snapshot cannot contain symbolic links");
    }
    if (stat.isDirectory()) {
      await sealTreeReadOnly(entryPath);
    } else if (stat.isFile()) {
      await fs.chmod(entryPath, 0o400);
    } else {
      throw new Error("Run snapshot cannot contain special files");
    }
  }
  // Keep directories owner-writable so standard recursive workspace cleanup
  // remains portable; every snapshot file is sealed read-only.
  await fs.chmod(directoryPath, 0o700);
}

export async function makeSessionRunSnapshotsWritable(
  sessionPath: string,
): Promise<void> {
  const runsPath = path.join(sessionPath, "runs");
  const entries = await fs
    .readdir(runsPath, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafePathSegment(entry.name)) continue;
    await makeRunSnapshotWritable(path.join(runsPath, entry.name));
  }
}

export async function makeRunSnapshotWritable(
  runPath: string,
): Promise<void> {
  await makeTreeWritable(path.join(runPath, "input-snapshot"));
  for (const filename of [
    "run.json",
    "workflow.yaml",
    "run-plan.json",
    "mcp-resolution.json",
  ]) {
    const filePath = path.join(runPath, filename);
    const stat = await fs.lstat(filePath).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      await fs.chmod(filePath, 0o600).catch(() => undefined);
    }
  }
}

async function makeTreeWritable(entryPath: string): Promise<void> {
  const stat = await fs.lstat(entryPath).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    await fs.chmod(entryPath, 0o600).catch(() => undefined);
    return;
  }
  if (!stat.isDirectory()) return;
  await fs.chmod(entryPath, 0o700).catch(() => undefined);
  const entries = await fs.readdir(entryPath, { withFileTypes: true });
  for (const entry of entries) {
    await makeTreeWritable(path.join(entryPath, entry.name));
  }
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  );
}
