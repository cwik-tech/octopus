import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const FILE_LOCK_TIMEOUT_MS = 5_000;
// New reclaim guards are atomically published files. This age applies only to
// ownerless directories left behind by the pre-atomic guard implementation.
const LEGACY_OWNERLESS_RECLAIM_GUARD_MAX_AGE_MS = 60_000;
const LEGACY_RECLAIM_GUARD_OWNER_FILENAME = "owner.json";

// Same-process callers should queue on an event, not race one another through
// the filesystem lock. The cross-process timeout below measures an external
// owner; starting that timeout while a known local operation is ahead in line
// made later callers expire under ordinary I/O pressure and silently lose
// retention projections.
const inProcessFileLockTails = new Map<string, Promise<void>>();

interface SessionFileLockRecord {
  pid: number;
  nonce: string;
  createdAt: string;
}

interface SessionReclaimGuardSnapshot {
  dev: number;
  ino: number;
  kind: "file" | "legacy_directory";
  mtimeMs: number;
  record: SessionFileLockRecord | null;
}

async function readSessionFileLockRecord(
  lockPath: string,
): Promise<SessionFileLockRecord | null> {
  try {
    const value = JSON.parse(
      await fs.readFile(lockPath, "utf8"),
    ) as Partial<SessionFileLockRecord>;
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.nonce !== "string" ||
      !value.nonce ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null;
    }
    return {
      pid: value.pid,
      nonce: value.nonce,
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

function isSessionLockOwnerAlive(record: SessionFileLockRecord): boolean {
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeOwnedSessionFileLock(
  lockPath: string,
  nonce: string,
): Promise<void> {
  const current = await readSessionFileLockRecord(lockPath);
  if (current?.nonce === nonce) {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

async function publishSessionFileLock(
  lockPath: string,
  record: SessionFileLockRecord,
): Promise<fs.FileHandle | null> {
  const candidatePath = `${lockPath}.candidate-${record.pid}-${record.nonce}`;
  const handle = await fs.open(candidatePath, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    try {
      await fs.link(candidatePath, lockPath);
      published = true;
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  } finally {
    await fs.unlink(candidatePath).catch(() => undefined);
    if (!published) await handle.close().catch(() => undefined);
  }
}

async function reclaimStaleSessionFileLock(lockPath: string): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  const guard = await acquireSessionReclaimGuard(reclaimPath);
  if (!guard) return false;

  try {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat) return true;
    const record = await readSessionFileLockRecord(lockPath);
    if (record && !isSessionLockOwnerAlive(record)) {
      if (!(await ownsSessionReclaimGuard(reclaimPath, guard))) return false;
      const currentStat = await fs.stat(lockPath).catch(() => null);
      const currentRecord = await readSessionFileLockRecord(lockPath);
      if (
        !currentStat ||
        currentStat.dev !== stat.dev ||
        currentStat.ino !== stat.ino ||
        currentRecord?.nonce !== record?.nonce ||
        currentRecord?.pid !== record?.pid
      ) {
        return false;
      }
      await fs.unlink(lockPath).catch(() => undefined);
      return true;
    }
    return false;
  } finally {
    await releaseSessionReclaimGuard(reclaimPath, guard);
  }
}

async function acquireSessionReclaimGuard(
  reclaimPath: string,
): Promise<SessionFileLockRecord | null> {
  await removeOrphanedSessionReclaimGuard(reclaimPath);

  const guard: SessionFileLockRecord = {
    pid: process.pid,
    nonce: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const handle = await publishSessionFileLock(reclaimPath, guard);
  await handle?.close().catch(() => undefined);
  return handle ? guard : null;
}

async function ownsSessionReclaimGuard(
  reclaimPath: string,
  guard: SessionFileLockRecord,
): Promise<boolean> {
  const current = await readSessionFileLockRecord(reclaimPath);
  return current?.pid === guard.pid && current.nonce === guard.nonce;
}

async function releaseSessionReclaimGuard(
  reclaimPath: string,
  guard: SessionFileLockRecord,
): Promise<void> {
  if (!(await ownsSessionReclaimGuard(reclaimPath, guard))) return;
  await fs.unlink(reclaimPath).catch(() => undefined);
}

async function readSessionReclaimGuardSnapshot(
  reclaimPath: string,
): Promise<SessionReclaimGuardSnapshot | null> {
  const stat = await fs.lstat(reclaimPath).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return null;
  const kind = stat.isFile()
    ? "file"
    : stat.isDirectory()
      ? "legacy_directory"
      : null;
  if (!kind) return null;
  const record = await readSessionFileLockRecord(
    kind === "file"
      ? reclaimPath
      : path.join(reclaimPath, LEGACY_RECLAIM_GUARD_OWNER_FILENAME),
  );
  return {
    dev: stat.dev,
    ino: stat.ino,
    kind,
    mtimeMs: stat.mtimeMs,
    record,
  };
}

function sameSessionReclaimGuard(
  left: SessionReclaimGuardSnapshot,
  right: SessionReclaimGuardSnapshot,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.kind === right.kind &&
    left.record?.pid === right.record?.pid &&
    left.record?.nonce === right.record?.nonce
  );
}

function sessionReclaimGuardIsOrphaned(
  snapshot: SessionReclaimGuardSnapshot,
): boolean {
  if (snapshot.record) return !isSessionLockOwnerAlive(snapshot.record);
  return (
    snapshot.kind === "legacy_directory" &&
    Date.now() - snapshot.mtimeMs >= LEGACY_OWNERLESS_RECLAIM_GUARD_MAX_AGE_MS
  );
}

async function removeOrphanedSessionReclaimGuard(
  reclaimPath: string,
): Promise<boolean> {
  const observed = await readSessionReclaimGuardSnapshot(reclaimPath);
  if (!observed || !sessionReclaimGuardIsOrphaned(observed)) return false;
  const confirmed = await readSessionReclaimGuardSnapshot(reclaimPath);
  if (
    !confirmed ||
    !sameSessionReclaimGuard(observed, confirmed) ||
    !sessionReclaimGuardIsOrphaned(confirmed)
  ) {
    return false;
  }

  const quarantinePath =
    `${reclaimPath}.orphan-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.rename(reclaimPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const moved = await readSessionReclaimGuardSnapshot(quarantinePath);
  if (
    !moved ||
    !sameSessionReclaimGuard(confirmed, moved) ||
    !sessionReclaimGuardIsOrphaned(moved)
  ) {
    await fs.rename(quarantinePath, reclaimPath).catch(() => undefined);
    return false;
  }
  if (moved.kind === "legacy_directory") {
    await fs.rm(quarantinePath, { recursive: true, force: true });
  } else {
    await fs.unlink(quarantinePath).catch(() => undefined);
  }
  return true;
}

async function withInProcessFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = inProcessFileLockTails.get(lockPath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  inProcessFileLockTails.set(lockPath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (inProcessFileLockTails.get(lockPath) === tail) {
      inProcessFileLockTails.delete(lockPath);
    }
  }
}

async function withCrossProcessFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const record: SessionFileLockRecord = {
    pid: process.pid,
    nonce: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let handle: fs.FileHandle | undefined;

  while (!handle) {
    const reclaimPath = `${lockPath}.reclaim`;
    if (existsSync(reclaimPath)) {
      if (await removeOrphanedSessionReclaimGuard(reclaimPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for lifecycle lock: ${path.basename(lockPath)}`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }
    let candidateHandle: fs.FileHandle | null;
    try {
      candidateHandle = await publishSessionFileLock(lockPath, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for lifecycle lock: ${path.basename(lockPath)}`,
        );
      }
      // The protected directory may be atomically removed by session
      // deletion after mkdir but before the candidate lock is opened/linked.
      // Retry against the current filesystem state instead of surfacing that
      // expected race as a task-creation failure.
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      continue;
    }
    if (!candidateHandle) {
      if (await reclaimStaleSessionFileLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for lifecycle lock: ${path.basename(lockPath)}`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }
    handle = candidateHandle;
    if (existsSync(reclaimPath)) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      await removeOwnedSessionFileLock(lockPath, record.nonce);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await removeOwnedSessionFileLock(lockPath, record.nonce);
  }
}

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withInProcessFileLock(lockPath, () =>
    withCrossProcessFileLock(lockPath, operation),
  );
}
