import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface SnapshotFile {
  contents: Buffer;
  mode: number;
  executable: boolean;
}

type SkillSnapshot = ReadonlyMap<string, SnapshotFile>;

export async function preserveSkillSnapshot(params: {
  repoRoot: string;
  source: string;
  skillName: string;
}): Promise<string> {
  const source = await readSkillSnapshot(params.source);
  if (source === null) {
    return path.join(params.repoRoot, "skills", params.skillName);
  }

  const primary = path.join(params.repoRoot, "skills", params.skillName);
  const primarySnapshot = await readSkillSnapshot(primary);
  if (primarySnapshot === null) {
    return publishSkillSnapshot(source, primary);
  }
  if (digestSkillSnapshot(primarySnapshot) === digestSkillSnapshot(source)) {
    return primary;
  }

  const digest = digestSkillSnapshot(source).slice(0, 16);
  const variant = path.join(
    params.repoRoot,
    "skills",
    `${params.skillName}-${digest}`,
    params.skillName,
  );
  const existingVariant = await readSkillSnapshot(variant);
  if (existingVariant !== null) {
    if (digestSkillSnapshot(existingVariant) !== digestSkillSnapshot(source)) {
      throw new Error(`Preserved skill variant does not match its digest: ${variant}`);
    }
    return variant;
  }
  return publishSkillSnapshot(source, variant);
}

async function publishSkillSnapshot(
  snapshot: SkillSnapshot,
  target: string,
): Promise<string> {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const staging = path.join(
    parent,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeSkillSnapshot(snapshot, staging);
    await fs.rename(staging, target);
    return target;
  } catch (error) {
    const existing = await readSkillSnapshot(target);
    if (
      existing !== null &&
      digestSkillSnapshot(existing) === digestSkillSnapshot(snapshot)
    ) {
      return target;
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function writeSkillSnapshot(
  snapshot: SkillSnapshot,
  target: string,
): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  for (const [relativePath, file] of snapshot) {
    const destination = path.join(target, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.contents, { mode: file.mode });
    await fs.chmod(destination, file.mode);
  }
}

async function readSkillSnapshot(root: string): Promise<SkillSnapshot | null> {
  const stat = await fs.lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Skill snapshot is not a real directory: ${root}`);
  }
  const files = new Map<string, SnapshotFile>();
  await collectSkillFiles(root, root, files);
  return files;
}

async function collectSkillFiles(
  root: string,
  directory: string,
  files: Map<string, SnapshotFile>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill snapshots cannot contain symbolic links: ${absolute}`);
    }
    if (entry.isDirectory()) {
      await collectSkillFiles(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Skill snapshots support only regular files: ${absolute}`);
    }
    const stat = await fs.stat(absolute);
    const relativePath = path.relative(root, absolute).split(path.sep).join("/");
    files.set(relativePath, {
      contents: await fs.readFile(absolute),
      mode: stat.mode & 0o777,
      executable: (stat.mode & 0o111) !== 0,
    });
  }
}

function digestSkillSnapshot(snapshot: SkillSnapshot): string {
  const digest = createHash("sha256");
  for (const [relativePath, file] of [...snapshot.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    digest.update(`${pathBytes.byteLength}:`, "utf8");
    digest.update(pathBytes);
    digest.update(file.executable ? "x" : "-", "utf8");
    digest.update(`${file.contents.byteLength}:`, "utf8");
    digest.update(file.contents);
  }
  return digest.digest("hex");
}
