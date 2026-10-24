/**
 * The Pi agent directory a Team host subprocess is given.
 *
 * Switching the host model is how a coordinator handover works, and in the
 * installed Pi 0.84.1 that switch is not session-local: `pi.setModel` delegates
 * to `AgentSession.setModel`, which calls
 * `settingsManager.setDefaultModelAndProvider` and saves
 * `join(agentDir, 'settings.json')`. The directory comes from
 * `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that is unset.
 *
 * The Team host inherits the parent's environment, so every handover has been
 * rewriting the user's own Pi default as a side effect of running a team. The
 * fix is to hand the subprocess its own agent directory: the same credentials
 * and model definitions it needs to work, and a settings file it is free to
 * rewrite because nothing outside the run reads it.
 *
 * Credentials are copied, so the copies matter as much as the isolation: the
 * directory is private to the user, each file is private to the user, and the
 * whole thing is removed when the run is over.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { getAgentDir } from '@earendil-works/pi-coding-agent'

import {
  disposeOwnedPiAgentDirectory,
  ISOLATED_DIRECTORY_PREFIX,
  isolatePiAgentDirectory,
  OWNED_AGENT_DIRECTORY_ROOT_ENV,
  OWNED_AGENT_DIRECTORY_TOKEN_ENV,
  resolveFilesystemOwnershipPolicy,
  type IsolatedPiAgentDirectory,
} from '../../domains/run/pi-agent-isolation.js'

const SHARED_SETTINGS = JSON.stringify(
  { defaultProvider: 'anthropic-api', defaultModel: 'user-chosen-model' },
  null,
  2,
)

/** A stand-in for the user's own `~/.pi/agent`. */
function sharedAgentDirectory(): string {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-agent-'))
  fs.writeFileSync(path.join(shared, 'settings.json'), SHARED_SETTINGS)
  fs.writeFileSync(path.join(shared, 'auth.json'), '{"anthropic":{"apiKey":"x"}}', { mode: 0o600 })
  fs.writeFileSync(path.join(shared, 'models.json'), '{"models":[]}')
  return shared
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777
}

/** What this platform can say about ownership, asked once. */
const POLICY = resolveFilesystemOwnershipPolicy(process.platform)

/**
 * Point the platform's temporary root at `root` and give back the undo.
 *
 * All three names, because `os.tmpdir()` reads `TMPDIR` on POSIX and `TEMP`
 * or `TMP` on Windows. Changing one would leave the others deciding.
 */
function withTemporaryRoot(root: string): () => void {
  const previous = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  }
  process.env.TMPDIR = root
  process.env.TMP = root
  process.env.TEMP = root
  return (): void => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * Apply an environment and give back the undo.
 *
 * Every key it sets is restored, so a test that installs a run's environment
 * cannot leave the ownership token or the canonical root behind for the next
 * one to read.
 */
function withEnvironment(entries: Readonly<Record<string, string>>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Whether this user may create a directory link at all. */
function canLinkDirectories(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'link-probe-'))
  try {
    fs.symlinkSync(probe, path.join(probe, 'link'), POLICY.directoryLinkType)
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

test('the isolated directory is not the shared one, and Pi resolves to it', () => {
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  // Every key the run would set, not only the one this test reads back: the
  // environment also carries the ownership token and the canonical root.
  const restoreEnvironment = withEnvironment(isolated.environment)
  try {
    assert.notEqual(isolated.path, shared, 'the run must not be handed the shared directory')

    // Pi's own resolution, under the environment the subprocess will be given.
    // This is the step that decides where `settings.json` is written, so it is
    // the step worth asserting rather than the variable's spelling.
    assert.equal(
      getAgentDir(),
      isolated.path,
      "Pi must resolve the subprocess's agent directory to the isolated copy",
    )
  } finally {
    restoreEnvironment()
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a host model switch inside the run leaves the shared default alone', () => {
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    // What Pi does on `setModel`, at the path Pi resolves for this subprocess.
    fs.writeFileSync(
      path.join(isolated.path, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic-api', defaultModel: 'handover-model' }),
    )

    assert.equal(
      fs.readFileSync(path.join(shared, 'settings.json'), 'utf8'),
      SHARED_SETTINGS,
      "a handover must not touch the user's own Pi default",
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('the run keeps the credentials and model definitions it needs', () => {
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    for (const name of ['auth.json', 'models.json', 'settings.json']) {
      assert.equal(
        fs.readFileSync(path.join(isolated.path, name), 'utf8'),
        fs.readFileSync(path.join(shared, name), 'utf8'),
        `${name} must be available to the run`,
      )
    }
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('the copies are readable only by their owner', function (t) {
  if (!POLICY.enforcesPermissionBits) {
    t.skip('this platform does not express POSIX permission bits')
    return
  }
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.equal(
      mode(isolated.path),
      0o700,
      'the directory holds a copy of the user credentials and must not be shared',
    )
    for (const name of ['auth.json', 'models.json', 'settings.json']) {
      assert.equal(
        mode(path.join(isolated.path, name)),
        0o600,
        `${name} must be private to the user`,
      )
    }
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('disposing removes the copied credentials', () => {
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  const isolatedPath = isolated.path
  try {
    assert.ok(fs.existsSync(path.join(isolatedPath, 'auth.json')), 'precondition: copied')
    isolated.dispose()
    assert.equal(
      fs.existsSync(isolatedPath),
      false,
      'the run must not leave a copy of the credentials behind',
    )
    // Runs end more than one way, and a second dispose must not be the thing
    // that turns a failed run into a crashed one.
    isolated.dispose()
  } finally {
    fs.rmSync(isolatedPath, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('an absent optional file is not invented', () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-agent-'))
  fs.writeFileSync(path.join(shared, 'auth.json'), '{}', { mode: 0o600 })
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.ok(fs.existsSync(path.join(isolated.path, 'auth.json')))
    assert.equal(
      fs.existsSync(path.join(isolated.path, 'models.json')),
      false,
      'a file the user does not have must not appear in the run',
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a shared file that cannot be copied fails closed and leaves nothing behind', () => {
  const shared = sharedAgentDirectory()
  // A directory where a file is expected: unreadable as a file on every
  // platform and at every privilege level, unlike a permission bit.
  fs.rmSync(path.join(shared, 'auth.json'))
  fs.mkdirSync(path.join(shared, 'auth.json'))
  // Its own containing directory, so the count cannot race with anything else
  // creating or removing isolated directories at the same time.
  const containing = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-failure-'))
  try {
    assert.throws(
      () =>
        isolatePiAgentDirectory({
          sharedAgentDirectoryPath: shared,
          containingDirectoryPath: containing,
        }),
      /agent directory/i,
      'the run must not start on the shared directory when isolation fails',
    )
    assert.deepEqual(
      fs.readdirSync(containing),
      [],
      'a failed isolation must not leave a half-built directory behind',
    )
  } finally {
    fs.rmSync(containing, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

// ── Ownership: who may delete a directory holding copied credentials ────────

test('a directory in the OS temp root is the child\'s to delete', () => {
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.equal(
      typeof isolated.environment[OWNED_AGENT_DIRECTORY_TOKEN_ENV],
      'string',
      'the child needs a token to prove the directory is the one it was given',
    )
    assert.equal(disposeOwnedPiAgentDirectory(isolated.environment), 'removed')
    assert.equal(fs.existsSync(isolated.path), false)
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a directory outside the OS temp root is the parent\'s alone', () => {
  const shared = sharedAgentDirectory()
  // What `runTeamAttempt` does: the directory lives inside the run's own
  // private tree, which the child must not be handed a licence to delete.
  const containing = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-'))
  const runPrivate = path.join(containing, '.runtime')
  fs.mkdirSync(runPrivate, { mode: 0o700 })
  const isolated = isolatePiAgentDirectory({
    sharedAgentDirectoryPath: shared,
    containingDirectoryPath: runPrivate,
  })
  try {
    assert.equal(
      isolated.environment[OWNED_AGENT_DIRECTORY_TOKEN_ENV],
      undefined,
      'a child must not be given a deletion token for a directory outside the temp root',
    )
    assert.equal(
      disposeOwnedPiAgentDirectory({
        ...isolated.environment,
        [OWNED_AGENT_DIRECTORY_TOKEN_ENV]: 'guessed-token',
      }),
      'not-owned',
      'child-side deletion must refuse a directory outside the real OS temp root',
    )
    assert.ok(fs.existsSync(isolated.path), 'it is still there for its owner')

    isolated.dispose()
    assert.equal(fs.existsSync(isolated.path), false, 'the parent removes it')
  } finally {
    fs.rmSync(containing, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a containing directory that does not exist is refused, not created', () => {
  const shared = sharedAgentDirectory()
  // A named child of a directory this test owns, so the path is absent by
  // construction rather than by being improbable.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'absent-containing-'))
  const missing = path.join(parent, 'never-created')
  try {
    assert.equal(fs.existsSync(missing), false, 'precondition: it is not there')
    assert.throws(
      () =>
        isolatePiAgentDirectory({
          sharedAgentDirectoryPath: shared,
          containingDirectoryPath: missing,
        }),
      /agent directory/i,
      'an arbitrary caller path must not be brought into existence',
    )
    assert.equal(fs.existsSync(missing), false, 'and must not be created')
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

// A user's own `PI_CODING_AGENT_DIR` is the thing this must never touch, so it
// is stated once per way the check could be got wrong.
for (const refusal of [
  {
    name: 'no token in the environment',
    mutate: (environment: Record<string, string>) => {
      delete environment[OWNED_AGENT_DIRECTORY_TOKEN_ENV]
    },
  },
  {
    name: 'a token that does not match the sentinel',
    mutate: (environment: Record<string, string>) => {
      environment[OWNED_AGENT_DIRECTORY_TOKEN_ENV] = 'not-the-token'
    },
  },
]) {
  test(`child-side deletion refuses ${refusal.name}`, () => {
    const shared = sharedAgentDirectory()
    const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
    try {
      const environment = { ...isolated.environment }
      refusal.mutate(environment)
      assert.equal(disposeOwnedPiAgentDirectory(environment), 'not-owned')
      assert.ok(fs.existsSync(isolated.path), 'the directory must survive a refusal')
    } finally {
      isolated.dispose()
      fs.rmSync(shared, { recursive: true, force: true })
    }
  })
}

test("a user's own agent directory is never deleted", () => {
  // Everything an attacker or a bug could control except the sentinel: the
  // right variable, a plausible token, a plausible root, and even the expected
  // name. The root is supplied deliberately — without it the check would return
  // early for an incomplete environment and never reach the sentinel, which is
  // the rule actually being tested.
  const userDirectory = fs.mkdtempSync(path.join(os.tmpdir(), ISOLATED_DIRECTORY_PREFIX))
  fs.writeFileSync(path.join(userDirectory, 'settings.json'), '{"defaultModel":"mine"}')
  try {
    assert.equal(
      disposeOwnedPiAgentDirectory({
        PI_CODING_AGENT_DIR: userDirectory,
        [OWNED_AGENT_DIRECTORY_TOKEN_ENV]: 'any-token',
        [OWNED_AGENT_DIRECTORY_ROOT_ENV]: fs.realpathSync(path.dirname(userDirectory)),
      }),
      'not-owned',
      'a directory with no sentinel belongs to whoever made it',
    )
    assert.ok(fs.existsSync(path.join(userDirectory, 'settings.json')))
  } finally {
    fs.rmSync(userDirectory, { recursive: true, force: true })
  }
})

test('a symlink pointing at somebody else\'s directory is refused', function (t) {
  if (!canLinkDirectories()) {
    t.skip('directory links are not available to this user')
    return
  }
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  const link = path.join(os.tmpdir(), `${ISOLATED_DIRECTORY_PREFIX}link-${process.pid}`)
  try {
    fs.symlinkSync(isolated.path, link, POLICY.directoryLinkType)
    assert.equal(
      disposeOwnedPiAgentDirectory({
        ...isolated.environment,
        PI_CODING_AGENT_DIR: link,
      }),
      'not-owned',
      'a link is not the directory it points at',
    )
    assert.ok(fs.existsSync(isolated.path), 'the target must survive')
  } finally {
    fs.rmSync(link, { force: true })
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a directory that has already gone is not an error', () => {
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.equal(disposeOwnedPiAgentDirectory(isolated.environment), 'removed')
    assert.equal(
      disposeOwnedPiAgentDirectory(isolated.environment),
      'already-absent',
      'a second cleanup must not be the thing that fails a finished run',
    )
  } finally {
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('the model store the installed ModelRuntime reads is carried across', () => {
  const shared = sharedAgentDirectory()
  fs.writeFileSync(path.join(shared, 'models-store.json'), '{"custom":["offline-model"]}')
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.equal(
      fs.readFileSync(path.join(isolated.path, 'models-store.json'), 'utf8'),
      '{"custom":["offline-model"]}',
      'dropping it would change which models the run believes exist',
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

// ── The user's own resources, which isolation must not take away ───────────
//
// The installed `ResourceLoader` reads `skills`, `prompts`, `themes` and
// `extensions` from the agent directory (`dist/core/resource-loader.js:621-625`)
// and its global context file from the directory itself (`:86`, candidates at
// `:32`). Isolating Pi's *writes* must not quietly change what a run *reads*.

function sharedAgentDirectoryWithResources(): string {
  const shared = sharedAgentDirectory()
  fs.mkdirSync(path.join(shared, 'extensions'))
  fs.writeFileSync(path.join(shared, 'extensions', 'user-extension.ts'), 'export default () => {}')
  fs.mkdirSync(path.join(shared, 'skills'))
  fs.writeFileSync(path.join(shared, 'skills', 'SKILL.md'), '# a user skill')
  fs.writeFileSync(path.join(shared, 'AGENTS.md'), '# user global context')
  fs.mkdirSync(path.join(shared, 'sessions'))
  fs.writeFileSync(path.join(shared, 'sessions', 'old.jsonl'), '{}')
  return shared
}

test('the run still reads the resources the user configured', () => {
  const shared = sharedAgentDirectoryWithResources()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.equal(
      fs.readFileSync(path.join(isolated.path, 'extensions', 'user-extension.ts'), 'utf8'),
      'export default () => {}',
      'a configured extension must still be visible to the run',
    )
    assert.equal(
      fs.readFileSync(path.join(isolated.path, 'skills', 'SKILL.md'), 'utf8'),
      '# a user skill',
      'a user skill must still be visible to the run',
    )
    assert.equal(
      fs.readFileSync(path.join(isolated.path, 'AGENTS.md'), 'utf8'),
      '# user global context',
      'the agent-level context file must still be visible to the run',
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('resources are linked, not copied, so later edits are still seen', () => {
  const shared = sharedAgentDirectoryWithResources()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.ok(
      fs.lstatSync(path.join(isolated.path, 'extensions')).isSymbolicLink(),
      'a resource directory must be read through, not duplicated',
    )
    fs.writeFileSync(path.join(shared, 'extensions', 'added-later.ts'), 'export default () => {}')
    assert.ok(
      fs.existsSync(path.join(isolated.path, 'extensions', 'added-later.ts')),
      'the run must see the user\'s directory, not a snapshot of it',
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('per-run state is not inherited from the user', () => {
  const shared = sharedAgentDirectoryWithResources()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.equal(
      fs.existsSync(path.join(isolated.path, 'sessions')),
      false,
      "the user's session history is not a resource this run should hold",
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('cleanup unlinks the resources instead of deleting them', () => {
  const shared = sharedAgentDirectoryWithResources()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })

  isolated.dispose()

  try {
    assert.equal(fs.existsSync(isolated.path), false, 'the run\'s directory is gone')
    // The whole reason linking is safe to do at all.
    assert.equal(
      fs.readFileSync(path.join(shared, 'extensions', 'user-extension.ts'), 'utf8'),
      'export default () => {}',
      "cleaning up a run must never reach into the user's own resources",
    )
    assert.equal(
      fs.readFileSync(path.join(shared, 'skills', 'SKILL.md'), 'utf8'),
      '# a user skill',
    )
  } finally {
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('the first context file in the installed lookup order wins', () => {
  const shared = sharedAgentDirectoryWithResources()
  fs.writeFileSync(path.join(shared, 'AGENTS.override.md'), '# the override')
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.equal(
      fs.readFileSync(path.join(isolated.path, 'AGENTS.override.md'), 'utf8'),
      '# the override',
    )
    assert.equal(
      fs.existsSync(path.join(isolated.path, 'AGENTS.md')),
      false,
      'the loader takes the first match, so carrying a second would change which one wins',
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

// ── Ownership, tightened ───────────────────────────────────────────────────

test('child deletion refuses a sentinel that names a different parent', () => {
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    // The token and the path still match; only the recorded parent is wrong.
    // A directory that is not where its creator put it is not the directory
    // its creator made.
    const sentinelPath = path.join(isolated.path, '.team-host-owned.json')
    const sentinel: unknown = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'))
    assert.ok(sentinel && typeof sentinel === 'object')
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({ ...sentinel, containingDirectoryPath: path.join(os.tmpdir(), 'elsewhere') }),
    )

    assert.equal(disposeOwnedPiAgentDirectory(isolated.environment), 'not-owned')
    assert.ok(fs.existsSync(isolated.path), 'the directory must survive a mismatched parent')
  } finally {
    fs.rmSync(isolated.path, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('the parent refuses to delete a directory that is no longer its own', () => {
  const shared = sharedAgentDirectory()
  const containing = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-'))
  const isolated = isolatePiAgentDirectory({
    sharedAgentDirectoryPath: shared,
    containingDirectoryPath: containing,
  })
  try {
    // Somebody replaced the directory between creation and cleanup. Same path,
    // different contents; the parent must notice rather than delete whatever is
    // there now.
    fs.rmSync(isolated.path, { recursive: true, force: true })
    fs.mkdirSync(isolated.path, { mode: 0o700 })
    fs.writeFileSync(path.join(isolated.path, 'someone-elses.txt'), 'not ours')

    isolated.dispose()

    assert.ok(
      fs.existsSync(path.join(isolated.path, 'someone-elses.txt')),
      'a replaced directory is not the one this run created',
    )
  } finally {
    fs.rmSync(containing, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a containing directory owned by somebody else is refused', function (t) {
  if (process.getuid === undefined) {
    t.skip('ownership is not exposed on this platform')
    return
  }
  const shared = sharedAgentDirectory()
  try {
    // Resolved, because `/tmp` is a symlink on macOS and a symlink would be
    // refused for being a link rather than for being somebody else's.
    const rootOwned = fs.realpathSync('/tmp')
    const owner = fs.statSync(rootOwned).uid
    if (owner === process.getuid?.()) {
      t.skip('the temporary root is owned by this user here')
      return
    }
    // If the check is missing, this call succeeds and hands back a real
    // directory. `assert.throws` would drop it on the floor, so it is captured
    // and disposed: a test for a leak must not be the thing that leaks.
    let unexpected: IsolatedPiAgentDirectory | undefined
    try {
      assert.throws(
        () => {
          unexpected = isolatePiAgentDirectory({
            sharedAgentDirectoryPath: shared,
            containingDirectoryPath: rootOwned,
          })
        },
        /agent directory/i,
        'a directory the user does not own is not a place for their credentials',
      )
    } finally {
      unexpected?.dispose()
    }
  } finally {
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a legacy oauth credential still reaches the run, and the original is untouched', () => {
  // The supported legacy state: `runMigrations` always runs (`dist/main.js:515`)
  // and converts `oauth.json` into `auth.json` when `auth.json` is absent,
  // renaming the original as it goes (`dist/migrations.js:16-64`). Without the
  // legacy file the run would have no credentials at all; with the user's own
  // file, the migration would rename theirs.
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-agent-'))
  fs.writeFileSync(path.join(shared, 'oauth.json'), '{"anthropic":{"refresh":"r"}}', {
    mode: 0o600,
  })
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    const isolatedOauth = path.join(isolated.path, 'oauth.json')
    assert.ok(
      fs.existsSync(isolatedOauth),
      'the run needs the legacy credential the migration reads',
    )

    // What the migration does to it.
    fs.renameSync(isolatedOauth, `${isolatedOauth}.migrated`)

    assert.ok(
      fs.existsSync(path.join(shared, 'oauth.json')),
      "the migration must rename the run's copy, never the user's own file",
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('the default temporary root is used whoever owns it', function (t) {
  // On Linux `os.tmpdir()` is normally the real, root-owned `/tmp`. Requiring
  // the *parent* to belong to the current user would stop every Team host from
  // launching there. The rule applies to a directory a caller names, not to the
  // one the platform provides; what must be the user's own is the directory
  // this creates inside it.
  const shared = sharedAgentDirectory()
  let isolated: IsolatedPiAgentDirectory | undefined
  try {
    isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
    const created = fs.lstatSync(isolated.path)
    assert.ok(created.isDirectory())
    if (POLICY.enforcesPermissionBits) {
      assert.equal(created.mode & 0o777, 0o700, "the run's own directory is private")
    }
    if (POLICY.enforcesOwnerId && process.getuid !== undefined) {
      assert.equal(created.uid, process.getuid(), 'and belongs to this user')
    }
  } finally {
    isolated?.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

// ── Portability ────────────────────────────────────────────────────────────

test('cleanup does not depend on where the temporary directory points now', () => {
  // A child may legitimately change `TMPDIR` — the nested runner sets it to the
  // attempt's own directory. Cleanup must still find the directory it owns, so
  // the root it was created in travels with the token instead of being read
  // back from the environment at deletion time.
  const shared = sharedAgentDirectory()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'moved-temp-root-'))
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  const restoreTemporaryRoot = withTemporaryRoot(elsewhere)
  try {
    assert.equal(
      disposeOwnedPiAgentDirectory(isolated.environment),
      'removed',
      'the directory a run owns is the one it was given, not one recomputed later',
    )
    assert.equal(fs.existsSync(isolated.path), false)
  } finally {
    restoreTemporaryRoot()
    isolated.dispose()
    fs.rmSync(elsewhere, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('the creation root is recorded canonically', function (t) {
  // A temporary root reached through a link is ordinary — `/tmp` is one on
  // macOS. Recording the alias would leave two spellings of the same directory
  // that never compare equal, so the canonical form is what travels.
  if (!canLinkDirectories()) {
    t.skip('directory links are not available to this user')
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aliased-temp-root-'))
  const real = path.join(root, 'real')
  const alias = path.join(root, 'alias')
  fs.mkdirSync(real)
  fs.symlinkSync(real, alias, POLICY.directoryLinkType)

  const shared = sharedAgentDirectory()
  const restoreTemporaryRoot = withTemporaryRoot(alias)
  let isolated: IsolatedPiAgentDirectory | undefined
  try {
    isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
    assert.equal(
      isolated.environment[OWNED_AGENT_DIRECTORY_ROOT_ENV],
      fs.realpathSync(real),
      'the root a run may delete inside must be recorded canonically',
    )
    assert.equal(
      disposeOwnedPiAgentDirectory(isolated.environment),
      'removed',
      'and must still match at deletion time',
    )
  } finally {
    restoreTemporaryRoot()
    isolated?.dispose()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a containing path that names a symlink is refused', function (t) {
  const shared = sharedAgentDirectory()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symlinked-parent-'))
  const real = path.join(root, 'real')
  const link = path.join(root, 'link')
  fs.mkdirSync(real)
  try {
    fs.symlinkSync(real, link, 'dir')
  } catch {
    t.skip('symlinks are not available to this user')
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
    return
  }
  let unexpected: IsolatedPiAgentDirectory | undefined
  try {
    assert.throws(
      () => {
        unexpected = isolatePiAgentDirectory({
          sharedAgentDirectoryPath: shared,
          containingDirectoryPath: link,
        })
      },
      /agent directory/i,
      'a directory named as a link is not a place; what it points at can change',
    )
  } finally {
    unexpected?.dispose()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a containing path reached through a linked component is canonicalised', function (t) {
  // The companion to the test above, and deliberately the opposite outcome. A
  // link *named* as the containing directory is refused; a link somewhere along
  // the way is resolved, because `/var` is one on macOS and `os.tmpdir()` sits
  // under it. What matters is that the recorded root is the real directory, so
  // a component swapped afterwards no longer matches what the run was given.
  const shared = sharedAgentDirectory()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-component-'))
  const real = path.join(root, 'real')
  fs.mkdirSync(path.join(real, 'inner'), { recursive: true })
  const link = path.join(root, 'link')
  try {
    fs.symlinkSync(real, link, 'dir')
  } catch {
    t.skip('symlinks are not available to this user')
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
    return
  }

  const isolated = isolatePiAgentDirectory({
    sharedAgentDirectoryPath: shared,
    containingDirectoryPath: path.join(link, 'inner'),
  })
  try {
    assert.equal(
      path.dirname(isolated.path),
      fs.realpathSync(path.join(real, 'inner')),
      'the run must be created in the real directory, not in a name for it',
    )
    isolated.dispose()
    assert.equal(fs.existsSync(isolated.path), false, 'and removed from it')
  } finally {
    isolated.dispose()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

// ── Platform policy ────────────────────────────────────────────────────────
//
// A pure decision, so the differences can be stated as a table instead of by
// mutating `process.platform` or standing in front of `fs`.

for (const expectation of [
  { platform: 'darwin', ownerId: true, permissionBits: true, link: 'dir' },
  { platform: 'linux', ownerId: true, permissionBits: true, link: 'dir' },
  { platform: 'freebsd', ownerId: true, permissionBits: true, link: 'dir' },
  { platform: 'win32', ownerId: false, permissionBits: false, link: 'junction' },
] as const) {
  test(`${expectation.platform} ownership policy`, () => {
    const policy = resolveFilesystemOwnershipPolicy(expectation.platform)
    assert.equal(
      policy.enforcesOwnerId,
      expectation.ownerId,
      'Windows has no POSIX uid to compare, and every other platform does',
    )
    assert.equal(
      policy.enforcesPermissionBits,
      expectation.permissionBits,
      'Windows cannot represent 0700/0600, so asserting them there would fail on a correct directory',
    )
    assert.equal(
      policy.directoryLinkType,
      expectation.link,
      'a junction is the directory link Windows grants without elevation',
    )
  })
}
