/**
 * A private Pi agent directory for a Team host subprocess.
 *
 * Switching the host model is how a coordinator handover works, and in the
 * installed Pi 0.84.1 that switch is not session-local: `pi.setModel` delegates
 * to `AgentSession.setModel`, which calls
 * `settingsManager.setDefaultModelAndProvider` and saves
 * `join(agentDir, 'settings.json')`. `agentDir` is `PI_CODING_AGENT_DIR`, or
 * `~/.pi/agent` when that is unset, and a subprocess inherits it — so a team
 * run has been rewriting the user's own Pi default as a side effect.
 *
 * The subprocess gets its own directory instead. Only Pi's mutable state is
 * copied into it — credentials, model definitions and the settings file a
 * handover rewrites. Everything the user actually configured, their extensions,
 * skills, prompts and themes, is linked through so the run reads what it always
 * read. Isolation here is about where Pi *writes*, not about what it can see.
 *
 * The directory holds a copy of the user's credentials, so who may delete it
 * matters as much as who may read it. There are two arrangements, and which one
 * applies is decided by whether the caller names a containing directory.
 *
 *   - **Child-owned.** No containing directory named, so it is created in the
 *     platform's temporary root. The child is given a token and the canonical
 *     root alongside `PI_CODING_AGENT_DIR`, which authorises it to delete the
 *     directory at its own process exit. This is what the two detached
 *     launchers use, and the authorisation matters because a detached child
 *     outlives the call that started it and may outlive the parent entirely.
 *     The parent still releases as a backstop — `launchDetachedProcess`
 *     registers a close listener and `launchTeamHostRun` releases on a launch
 *     that never started — so whichever of the two is still there does it.
 *   - **Parent-owned.** A containing directory is named — the nested runner
 *     passes its own attempt directory, inside the run's private `.runtime`
 *     tree. No token is issued, so the child cannot delete it even if it tried,
 *     and the parent removes it when the attempt settles.
 *
 * Either way the proof is the same: a generated token must match a sentinel
 * written inside the directory, which also records the directory's own path and
 * the canonical root it was created in. A `PI_CODING_AGENT_DIR` the user set
 * themselves carries no sentinel and is therefore never a candidate for
 * deletion.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { getAgentDir } from '@earendil-works/pi-coding-agent'

/**
 * The mutable Pi state a run is given its own copy of.
 *
 * `settings.json` is the file this whole module exists for: a handover writes
 * the host model there, and in the copy that write stays inside the run.
 * `auth.json` carries the provider credentials and `models.json` the model
 * definitions. `models-store.json` sits beside `models.json` and is read by the
 * installed `ModelRuntime` (`dist/core/model-runtime.js:80`,
 * `dist/core/models-store.js:29`), so dropping it would change which models the
 * run believes exist, custom and offline entries included.
 */
const COPIED_FILES = [
  'auth.json',
  // The legacy credential. `runMigrations` always runs (`dist/main.js:515`) and
  // converts this into `auth.json` when `auth.json` is absent, renaming the
  // original as it does (`dist/migrations.js:16-64`). Copied so a run in that
  // supported state still has credentials, and so the rename lands on the
  // run's copy instead of the user's file.
  'oauth.json',
  'models.json',
  'models-store.json',
  'settings.json',
] as const

/**
 * The user's own resources, linked rather than copied so the run still reads
 * exactly what it read before.
 *
 * The installed `ResourceLoader` treats these as agent-level roots
 * (`dist/core/resource-loader.js:621-625`), and skills resolve under the agent
 * directory as well (`dist/core/skills.js:295`). Isolating the directory
 * without them would silently take the user's extensions, skills, prompts and
 * themes away from every team run — a behaviour change nobody asked for, and
 * not one this module is for.
 *
 * `sessions` and the debug log are deliberately absent: they are per-run state
 * the isolated directory should own, not user resources to preserve.
 */
const LINKED_DIRECTORIES = [
  'skills',
  'prompts',
  'themes',
  'extensions',
  'tools',
  'bin',
  // Where settings-declared packages are installed
  // (`dist/core/package-manager.js:1677-1679` and `:1752-1754`). Without these,
  // a `settings.json` that names packages would find none installed, and the
  // run could try to install them again.
  'npm',
  'git',
] as const

/**
 * The agent directory's own context file, in the installed lookup order.
 *
 * `loadContextFileFromDir(resolvedAgentDir)` supplies the global context
 * (`dist/core/resource-loader.js:86`, candidates at `:32`), and it takes the
 * first that exists. Copied rather than linked: it is a small read-only input,
 * and a copy needs no platform-specific link support.
 */
const CONTEXT_FILE_CANDIDATES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
] as const

/**
 * Agent-level inputs a run reads but does not own.
 *
 * `SYSTEM.md` and `APPEND_SYSTEM.md` are the global system-prompt files
 * (`dist/core/resource-loader.js:808-826`). `trust.json` records which projects
 * the user has already trusted; the installed startup consults it before
 * loading project resources (`dist/main.js:558`, `:578`, store at
 * `dist/core/trust-manager.js:172`), so a run without it would find a
 * previously trusted project untrusted.
 *
 * Copied rather than linked: each is a single small file, and a copy needs no
 * platform-specific link support. `trust.json` is copied for a second reason —
 * a decision this run happens to record must not be written back into the
 * user's own file.
 *
 * Deliberately excluded, on installed evidence: `keybindings.json` is read only
 * by the interactive key handler (`KeybindingsManager.create()` appears solely
 * in `dist/modes/interactive/interactive-mode.js:357`), and a Team host never
 * resolves to interactive mode — the nested runner passes `-p --mode json` and
 * both detached launchers spawn with `stdio: "ignore"`, so `resolveAppMode`
 * (`dist/main.js:83-96`, used at `:503`) cannot return `interactive`.
 *
 * `oauth.json` is not excluded; it is copied with the mutable files above,
 * because the legacy migration rewrites it.
 */
const COPIED_RESOURCE_FILES = [
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
  'trust.json',
] as const

/** Names these directories unambiguously among other temporary state. */
export const ISOLATED_DIRECTORY_PREFIX = 'team-host-pi-agent-'

/** Carries the ownership token to the child that may delete the directory. */
export const OWNED_AGENT_DIRECTORY_TOKEN_ENV = 'TEAM_HOST_PI_AGENT_DIR_TOKEN'

/** Carries the root the directory was created in, so deletion need not guess. */
export const OWNED_AGENT_DIRECTORY_ROOT_ENV = 'TEAM_HOST_PI_AGENT_DIR_ROOT'

export interface FilesystemOwnershipPolicy {
  /** Whether a numeric owner exists to compare against the current user. */
  readonly enforcesOwnerId: boolean
  /** Whether POSIX permission bits mean anything here. */
  readonly enforcesPermissionBits: boolean
  /** How a directory link must be created for the platform to accept it. */
  readonly directoryLinkType: 'dir' | 'junction'
}

/**
 * What this platform can actually say about who owns a file.
 *
 * Pure, and taking the platform as an argument, so the differences can be
 * covered as a table rather than by mutating `process.platform` or standing in
 * front of the filesystem. Windows has no POSIX uid and cannot represent
 * `0700`; asserting either there would fail on a perfectly good directory. What
 * survives everywhere is the sentinel and the token, which is what actually
 * proves ownership.
 */
export function resolveFilesystemOwnershipPolicy(
  platform: NodeJS.Platform,
): FilesystemOwnershipPolicy {
  if (platform === 'win32') {
    return {
      enforcesOwnerId: false,
      enforcesPermissionBits: false,
      // The one directory link Windows grants without elevation.
      directoryLinkType: 'junction',
    }
  }
  return {
    enforcesOwnerId: true,
    enforcesPermissionBits: true,
    directoryLinkType: 'dir',
  }
}

/** Written inside the directory; its absence is what protects a user's own. */
const SENTINEL_FILENAME = '.team-host-owned.json'

interface OwnershipSentinel {
  readonly token: string
  readonly directoryPath: string
  readonly containingDirectoryPath: string
}

export interface IsolatedPiAgentDirectory {
  /** The directory the subprocess should treat as its agent directory. */
  readonly path: string
  /** Environment entries that point Pi at it and prove ownership of it. */
  readonly environment: Readonly<Record<string, string>>
  /** Remove the directory and the credential copies inside it. Idempotent. */
  dispose(): void
}

export function isolatePiAgentDirectory(
  input: {
    /** Defaults to Pi's own resolution of the user's agent directory. */
    readonly sharedAgentDirectoryPath?: string
    /**
     * Where to create it. Must already exist and be a real directory.
     *
     * Supplying one makes the result parent-owned: it is outside the temporary
     * root, so the child is given no token for it and cannot delete it.
     * Defaults to the temporary root, where the child owns its own cleanup.
     */
    readonly containingDirectoryPath?: string
  } = {},
): IsolatedPiAgentDirectory {
  const sharedPath = input.sharedAgentDirectoryPath ?? getAgentDir()
  const childMayDelete = input.containingDirectoryPath === undefined
  const policy = resolveFilesystemOwnershipPolicy(process.platform)
  const requestedContainingPath = input.containingDirectoryPath ?? os.tmpdir()

  let containingDirectoryPath: string
  let isolatedPath: string
  try {
    // Canonical from here on. The platform's temporary root is routinely an
    // alias — `/tmp` is a symlink to `/private/tmp` on macOS — and recording
    // one spelling while later comparing the other leaves two names for the
    // same directory that never match.
    // A directory named as a link is refused outright: the caller pointed at a
    // link, not at a place, and what it points at can change afterwards.
    if (
      input.containingDirectoryPath !== undefined &&
      fs.lstatSync(input.containingDirectoryPath).isSymbolicLink()
    ) {
      throw new Error(
        `'${input.containingDirectoryPath}' is a link, not a directory.`,
      )
    }
    // Everything else is canonicalised rather than refused. A link somewhere in
    // the path is ordinary — `/var` is one on macOS, and `os.tmpdir()` sits
    // under it — so refusing them would reject the platform's own temporary
    // root. Resolving instead means the recorded root, the sentinel and every
    // later comparison all speak about the same real directory, and a component
    // swapped afterwards no longer matches.
    containingDirectoryPath = fs.realpathSync(requestedContainingPath)

    // Required to exist already: creating an arbitrary caller-supplied path
    // would put a copy of the user's credentials somewhere nobody vouched for.
    const containing = fs.lstatSync(containingDirectoryPath)
    if (!containing.isDirectory()) {
      throw new Error(`'${containingDirectoryPath}' is not a directory.`)
    }
    // A directory a caller named must also be one this user owns: putting a
    // copy of the credentials somewhere belonging to somebody else is the thing
    // to refuse. The platform's own temporary root is exempt, because it is
    // normally root-owned on Linux and requiring otherwise would stop every
    // Team host from launching. What must be the user's there is the directory
    // created inside it, checked below.
    const currentUserId = policy.enforcesOwnerId ? process.getuid?.() : undefined
    if (
      input.containingDirectoryPath !== undefined &&
      currentUserId !== undefined &&
      containing.uid !== currentUserId
    ) {
      throw new Error(
        `'${containingDirectoryPath}' is not owned by the current user.`,
      )
    }
    isolatedPath = fs.mkdtempSync(
      path.join(containingDirectoryPath, ISOLATED_DIRECTORY_PREFIX),
    )
  } catch (error) {
    throw new Error(
      `Failed to prepare a private Pi agent directory in '${requestedContainingPath}'.`,
      { cause: error },
    )
  }

  const token = randomUUID()
  try {
    // The directory holds a copy of the user's credentials, so it is theirs
    // alone. `mkdtemp` already creates it privately; this states it rather than
    // relying on the platform default, and then confirms it — including in the
    // shared temporary root, where the parent's ownership was not required.
    if (policy.enforcesPermissionBits) fs.chmodSync(isolatedPath, 0o700)
    const created = fs.lstatSync(isolatedPath)
    if (!created.isDirectory()) {
      throw new Error(`'${isolatedPath}' is not a directory.`)
    }
    const ownerId = policy.enforcesOwnerId ? process.getuid?.() : undefined
    if (ownerId !== undefined && created.uid !== ownerId) {
      throw new Error(`'${isolatedPath}' is not owned by the current user.`)
    }
    if (policy.enforcesPermissionBits && (created.mode & 0o777) !== 0o700) {
      throw new Error(`'${isolatedPath}' is not private to the current user.`)
    }

    for (const name of COPIED_FILES) {
      const source = path.join(sharedPath, name)
      if (!fs.existsSync(source)) continue
      const destination = path.join(isolatedPath, name)
      fs.copyFileSync(source, destination)
      if (policy.enforcesPermissionBits) fs.chmodSync(destination, 0o600)
    }

    // Read-through, so the run sees the user's own resources unchanged. A
    // junction on Windows, where creating a directory symlink needs privileges
    // a background run cannot assume it has.
    for (const name of LINKED_DIRECTORIES) {
      const source = path.join(sharedPath, name)
      if (!fs.existsSync(source)) continue
      fs.symlinkSync(source, path.join(isolatedPath, name), policy.directoryLinkType)
    }

    for (const name of COPIED_RESOURCE_FILES) {
      const source = path.join(sharedPath, name)
      if (!fs.existsSync(source)) continue
      fs.copyFileSync(source, path.join(isolatedPath, name))
    }

    for (const name of CONTEXT_FILE_CANDIDATES) {
      const source = path.join(sharedPath, name)
      if (!fs.existsSync(source)) continue
      // First match wins, exactly as the installed loader picks it.
      fs.copyFileSync(source, path.join(isolatedPath, name))
      break
    }

    const sentinel: OwnershipSentinel = {
      token,
      directoryPath: isolatedPath,
      containingDirectoryPath,
    }
    fs.writeFileSync(
      path.join(isolatedPath, SENTINEL_FILENAME),
      JSON.stringify(sentinel),
      policy.enforcesPermissionBits ? { mode: 0o600 } : {},
    )
  } catch (error) {
    // Fail closed. Running on the shared directory is the whole defect this
    // exists to prevent, so a half-built copy is removed and the run does not
    // start rather than starting somewhere it can do harm.
    removeIsolatedDirectory(isolatedPath)
    throw new Error(
      `Failed to prepare a private Pi agent directory from '${sharedPath}'.`,
      { cause: error },
    )
  }

  return {
    path: isolatedPath,
    environment: childMayDelete
      ? {
          PI_CODING_AGENT_DIR: isolatedPath,
          [OWNED_AGENT_DIRECTORY_TOKEN_ENV]: token,
          // Carried, not recomputed: a child may change `TMPDIR` — the nested
          // runner sets it to the attempt's own directory — and a deletion that
          // asked the environment again would no longer recognise its own.
          [OWNED_AGENT_DIRECTORY_ROOT_ENV]: containingDirectoryPath,
        }
      : { PI_CODING_AGENT_DIR: isolatedPath },
    dispose(): void {
      // The same proof the child must give. A directory replaced between
      // creation and cleanup no longer carries this token, and is left alone.
      disposeOwnedDirectory({
        directoryPath: isolatedPath,
        token,
        requiredContainingDirectoryPath: containingDirectoryPath,
      })
    },
  }
}

export type OwnedDirectoryDisposal =
  | 'removed'
  | 'already-absent'
  | 'not-owned'

/**
 * The three values that prove a directory is this process's to remove.
 *
 * All three required, so a value of this type is proof rather than a shape that
 * might be proof. An environment is the opposite: every key is optional, so a
 * function taking one has to re-ask whether it was given anything at all, and a
 * caller can hand it an object missing the very fields the removal turns on.
 */
export interface OwnedPiAgentDirectoryProof {
  readonly directoryPath: string
  readonly token: string
  readonly containingDirectoryPath: string
}

/**
 * Read the proof an environment carries, if it carries one.
 *
 * The one place these three variables are parsed. `process.env` is mutable and
 * shared: a host process that runs one session after another can be pointed at
 * a different `PI_CODING_AGENT_DIR` — the user's own, even — long after the
 * directory this run was given was created. Reading the proof when the process
 * exits would aim the removal at whatever the environment says by then; reading
 * it once, here, aims it at the directory the run was actually handed.
 *
 * @returns the frozen proof, or null when the environment carries none — in
 *   which case this process owns no directory and there is nothing to register.
 */
export function captureOwnedPiAgentDirectoryProof(
  environment: NodeJS.ProcessEnv,
): OwnedPiAgentDirectoryProof | null {
  const directoryPath = environment.PI_CODING_AGENT_DIR?.trim()
  const token = environment[OWNED_AGENT_DIRECTORY_TOKEN_ENV]?.trim()
  const containingDirectoryPath = environment[OWNED_AGENT_DIRECTORY_ROOT_ENV]?.trim()
  if (!directoryPath || !token || !containingDirectoryPath) return null

  return Object.freeze({ directoryPath, token, containingDirectoryPath })
}

/** Every owned directory still waiting for this process to end, by path. */
const ownedDirectoriesAwaitingExit = new Map<string, OwnedPiAgentDirectoryProof>()

let ownedDirectoryExitListener: (() => void) | null = null

/**
 * Arrange for this directory to be removed when the process ends.
 *
 * Registration only: nothing is deleted here. The deletion has to wait, because
 * Pi goes on writing its settings after extensions have shut down and a
 * directory removed at `session_shutdown` is recreated and left behind. Exit is
 * the first moment nothing will write to it again.
 *
 * One listener serves every directory, however many sessions a host has owned.
 * Registering per directory instead is how a long-lived host accumulates exit
 * callbacks until Node reports a leak it is right about.
 */
export function registerOwnedPiAgentDirectoryExitCleanup(
  proof: OwnedPiAgentDirectoryProof,
): void {
  // Keyed by path, so the same directory registered twice is still one entry.
  ownedDirectoriesAwaitingExit.set(proof.directoryPath, proof)

  if (ownedDirectoryExitListener) return
  ownedDirectoryExitListener = (): void => {
    for (const owned of ownedDirectoriesAwaitingExit.values()) {
      // The root travels with the token, so this is the directory the run was
      // actually given rather than whatever the environment points at now.
      disposeOwnedDirectory({
        directoryPath: owned.directoryPath,
        token: owned.token,
        requiredContainingDirectoryPath: owned.containingDirectoryPath,
      })
    }
    ownedDirectoriesAwaitingExit.clear()
  }
  process.once('exit', ownedDirectoryExitListener)
}

/**
 * Delete a Pi agent directory, but only one this run was given.
 *
 * Everything here exists to make a mistake impossible rather than unlikely: the
 * environment must carry a token, the path must be named like one of ours, must
 * be a real directory rather than a link to one, must sit exactly where its
 * creator put it, and must contain a sentinel whose token and recorded path
 * match. A directory the user configured themselves fails at the sentinel and
 * is left alone.
 *
 * Never throws. Deleting is a cleanup step and must not be the thing that turns
 * a finished run into a failed one.
 */
export function disposeOwnedPiAgentDirectory(
  environment: NodeJS.ProcessEnv,
): OwnedDirectoryDisposal {
  const proof = captureOwnedPiAgentDirectoryProof(environment)
  if (!proof) return 'not-owned'

  // A directory a run keeps in its own private tree is the parent's to remove
  // and is never given a token, so it cannot arrive here.
  return disposeOwnedDirectory({
    directoryPath: proof.directoryPath,
    token: proof.token,
    requiredContainingDirectoryPath: proof.containingDirectoryPath,
  })
}

/**
 * Remove a directory only on proof that it is the one the caller made.
 *
 * Every check is about the same question asked a different way: the name, the
 * kind of filesystem entry, the token, the path the sentinel recorded, and the
 * parent the sentinel recorded. A directory that fails any of them is somebody
 * else's, including a directory that was replaced at the same path after it was
 * created.
 */
function disposeOwnedDirectory(input: {
  readonly directoryPath: string
  readonly token: string
  readonly requiredContainingDirectoryPath: string
}): OwnedDirectoryDisposal {
  const { directoryPath, token, requiredContainingDirectoryPath } = input
  if (!path.basename(directoryPath).startsWith(ISOLATED_DIRECTORY_PREFIX)) {
    return 'not-owned'
  }

  let entry: fs.Stats
  try {
    entry = fs.lstatSync(directoryPath)
  } catch {
    return 'already-absent'
  }
  // `lstat`, so a symlink pointing at somebody else's directory is refused
  // rather than followed.
  if (!entry.isDirectory()) return 'not-owned'

  const sentinel = readOwnershipSentinel(directoryPath)
  if (!sentinel) return 'not-owned'
  if (sentinel.token !== token) return 'not-owned'
  if (sentinel.directoryPath !== directoryPath) return 'not-owned'
  if (sentinel.containingDirectoryPath !== requiredContainingDirectoryPath) {
    return 'not-owned'
  }
  if (!isDirectChildOfRealPath(directoryPath, requiredContainingDirectoryPath)) {
    return 'not-owned'
  }

  return removeIsolatedDirectory(directoryPath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the sentinel as data.
 *
 * Its contents came off disk, so every field is checked before it is believed
 * and the result is built from the checked values rather than asserted into
 * shape.
 */
function readOwnershipSentinel(
  directoryPath: string,
): OwnershipSentinel | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(directoryPath, SENTINEL_FILENAME), 'utf8'),
    )
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { token, directoryPath: recordedPath, containingDirectoryPath } = parsed
  if (
    typeof token !== 'string' ||
    typeof recordedPath !== 'string' ||
    typeof containingDirectoryPath !== 'string'
  ) {
    return null
  }
  return { token, directoryPath: recordedPath, containingDirectoryPath }
}

/**
 * Whether the directory is a direct child of `parentPath`, canonically.
 *
 * Both sides are resolved, so neither a link in the path nor a platform that
 * reports the temporary root through one (macOS `/tmp` -> `/private/tmp`) can
 * make an unrelated location look like the right one.
 */
function isDirectChildOfRealPath(
  directoryPath: string,
  parentPath: string,
): boolean {
  try {
    return (
      path.dirname(fs.realpathSync(directoryPath)) ===
      fs.realpathSync(parentPath)
    )
  } catch {
    return false
  }
}

/**
 * Remove the directory without following anything it links to.
 *
 * The linked resources belong to the user. `fs.rm` with `recursive` unlinks a
 * symlink rather than descending into it, which is what makes linking the
 * user's extensions and skills safe to clean up at all.
 */
function removeIsolatedDirectory(directoryPath: string): OwnedDirectoryDisposal {
  try {
    fs.rmSync(directoryPath, { recursive: true, force: true })
  } catch {
    return 'not-owned'
  }
  return 'removed'
}
