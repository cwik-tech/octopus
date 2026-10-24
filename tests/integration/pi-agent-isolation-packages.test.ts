/**
 * Settings-declared packages, and whether a run still resolves them.
 *
 * A `settings.json` can name npm and git packages, and the installed
 * `DefaultPackageManager` looks for them under the agent directory: npm at
 * `<agentDir>/npm/node_modules/<name>` (`dist/core/package-manager.js:1718`)
 * and git at `<agentDir>/git/<host>/<user>/<project>`
 * (`getGitInstallPath` via `getGitInstallRoot`, `:1752-1754`). Isolating the
 * agent directory would take both stores away, and a run would then find its
 * packages missing — or try to install them again.
 *
 * Checking that the directories were linked proves placement, not resolution.
 * These load the packages through Pi's own `DefaultResourceLoader` and compare
 * the resources it returns before and after isolation.
 *
 * Nothing is installed and nothing is fetched. The packages are already on disk
 * with versions pinned to match, which is the state in which the installed
 * resolver does no work (`:1712-1718` for npm, and a present git directory at
 * user scope is never refreshed). `PI_OFFLINE=1` is set as well, which makes
 * every install path a no-op regardless.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  DefaultResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

import { isolatePiAgentDirectory } from '../../domains/run/pi-agent-isolation.js'

const NPM_PACKAGE_NAME = 'pi-fixture-npm-package'
/** Pinned exactly: an unpinned or mismatched version asks to be reinstalled. */
const NPM_PACKAGE_VERSION = '1.0.0'
const NPM_SKILL_NAME = 'npm-package-skill'

const GIT_SOURCE = 'https://github.com/pi-fixture-owner/pi-fixture-git-package'
const GIT_HOST = 'github.com'
const GIT_PATH = 'pi-fixture-owner/pi-fixture-git-package'
const GIT_SKILL_NAME = 'git-package-skill'

function writeSkillPackage(
  packageRoot: string,
  packageName: string,
  version: string,
  skillName: string,
): void {
  fs.mkdirSync(path.join(packageRoot, 'skills', skillName), { recursive: true })
  fs.writeFileSync(
    path.join(packageRoot, 'skills', skillName, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Provided by a preinstalled package.\n---\n\nBody.\n`,
  )
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version,
        pi: { skills: [`skills/${skillName}`] },
      },
      null,
      2,
    ),
  )
}

/** A user agent directory with one npm and one git package already installed. */
function sharedAgentDirectoryWithPackages(): string {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-agent-packages-'))
  fs.writeFileSync(path.join(shared, 'auth.json'), '{}', { mode: 0o600 })
  fs.writeFileSync(
    path.join(shared, 'settings.json'),
    JSON.stringify(
      {
        packages: [`npm:${NPM_PACKAGE_NAME}@${NPM_PACKAGE_VERSION}`, GIT_SOURCE],
      },
      null,
      2,
    ),
  )

  writeSkillPackage(
    path.join(shared, 'npm', 'node_modules', NPM_PACKAGE_NAME),
    NPM_PACKAGE_NAME,
    NPM_PACKAGE_VERSION,
    NPM_SKILL_NAME,
  )
  writeSkillPackage(
    path.join(shared, 'git', GIT_HOST, ...GIT_PATH.split('/')),
    'pi-fixture-git-package',
    '0.0.0',
    GIT_SKILL_NAME,
  )
  return shared
}

async function skillNamesFrom(agentDir: string, cwd: string): Promise<string[]> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
  })
  await loader.reload()
  return loader.getSkills().skills.map((skill) => skill.name).sort()
}

test('Pi resolves preinstalled npm and git packages after isolation', async () => {
  const previousOffline = process.env.PI_OFFLINE
  // Belt and braces: every install path in the resolver is a no-op under this,
  // so a fixture mistake cannot become a network call.
  process.env.PI_OFFLINE = '1'
  const shared = sharedAgentDirectoryWithPackages()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'))
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    const before = await skillNamesFrom(shared, cwd)
    const after = await skillNamesFrom(isolated.path, cwd)

    // Stated first, so a fixture that resolves neither package fails as "the
    // packages are missing" rather than as two matching lists that happen to
    // agree about nothing. The loader also returns Pi's own bundled skills, so
    // membership is the claim here and the full comparison follows.
    assert.ok(
      before.includes(NPM_SKILL_NAME),
      `precondition: the npm package resolves before isolation; saw ${JSON.stringify(before)}`,
    )
    assert.ok(
      before.includes(GIT_SKILL_NAME),
      `precondition: the git package resolves before isolation; saw ${JSON.stringify(before)}`,
    )
    // One per store, so a store that stopped being reachable says which.
    assert.ok(
      after.includes(NPM_SKILL_NAME),
      `the npm store must still resolve inside the run; saw ${JSON.stringify(after)}`,
    )
    assert.ok(
      after.includes(GIT_SKILL_NAME),
      `the git store must still resolve inside the run; saw ${JSON.stringify(after)}`,
    )
    assert.deepEqual(
      after,
      before,
      'a run must resolve exactly the resources the user has installed',
    )
  } finally {
    isolated.dispose()
    if (previousOffline === undefined) delete process.env.PI_OFFLINE
    else process.env.PI_OFFLINE = previousOffline
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})
