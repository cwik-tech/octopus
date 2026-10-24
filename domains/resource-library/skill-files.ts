import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ResourceSkillFile {
  contents: Buffer;
  mode: number;
  executable: boolean;
}

export type ResourceSkillFiles = ReadonlyMap<string, ResourceSkillFile>;

export function normalizeResourcePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new Error(`Invalid resource path: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Invalid resource path: ${value}`);
  }
  return parts.join("/");
}

export async function readResourceSkillFiles(
  root: string,
): Promise<ResourceSkillFiles | null> {
  const stat = await fs.lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Skill root is not a real directory: ${root}`);
  }
  const files = new Map<string, ResourceSkillFile>();
  await collectResourceSkillFiles(root, root, files);
  return files;
}

export function requireSkillDocument(files: ResourceSkillFiles): Buffer {
  const document = files.get("SKILL.md");
  if (!document) throw new Error("Skill folder must contain SKILL.md");
  return document.contents;
}

export function digestResourceSkillFiles(files: ResourceSkillFiles): string {
  const digest = createHash("sha256");
  for (const [relativePath, file] of sortedFiles(files)) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    digest.update(`${pathBytes.byteLength}:`, "utf8");
    digest.update(pathBytes);
    digest.update(file.executable ? "x" : "-", "utf8");
    digest.update(`${file.contents.byteLength}:`, "utf8");
    digest.update(file.contents);
  }
  return `sha256:${digest.digest("hex")}`;
}

export function digestResourceFile(contents: Buffer): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

export async function writeResourceSkillFiles(
  files: ResourceSkillFiles,
  target: string,
): Promise<void> {
  await fs.mkdir(target);
  for (const [relativePath, file] of sortedFiles(files)) {
    const normalized = normalizeResourcePath(relativePath);
    const destination = path.join(target, ...normalized.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.contents, { mode: file.mode });
    await fs.chmod(destination, file.mode);
  }
}

export function filesFromBuffers(
  inputs: ReadonlyMap<string, Buffer>,
): ResourceSkillFiles {
  return new Map(
    [...inputs.entries()].map(([relativePath, contents]) => [
      normalizeResourcePath(relativePath),
      {
        contents,
        mode: 0o644,
        executable: false,
      },
    ]),
  );
}

function sortedFiles(files: ResourceSkillFiles): [string, ResourceSkillFile][] {
  return [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
}

async function collectResourceSkillFiles(
  root: string,
  directory: string,
  files: Map<string, ResourceSkillFile>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill resources cannot contain symbolic links: ${absolute}`);
    }
    if (entry.isDirectory()) {
      await collectResourceSkillFiles(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Skill resources must be regular files: ${absolute}`);
    }
    const stat = await fs.stat(absolute);
    const relativePath = normalizeResourcePath(
      path.relative(root, absolute).split(path.sep).join("/"),
    );
    files.set(relativePath, {
      contents: await fs.readFile(absolute),
      mode: stat.mode & 0o777,
      executable: (stat.mode & 0o111) !== 0,
    });
  }
}
