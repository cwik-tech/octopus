/**
 * Setup mode's prompt must reach every build tree the Team runtime runs from.
 *
 * `team-runtime/index.ts` reads the prompt at `__dirname/../setup/setup-agent.md`.
 * `tsc` emits only JavaScript, so a compiled runtime finds the file only if a
 * build stages it beside the compiled tree. Nothing did. The compiled
 * `team-runtime-boot-state` case failed from `.tests-dist` while passing from
 * source. A packaged app would do worse: the runtime skips a missing prompt
 * without a word, so setup mode would start without its setup prompt.
 *
 * These pin the layout in both trees: the compiled test tree that
 * `tests/run-tests.mjs` stages, and the packaged app that `electron:build`
 * stages into `dist-electron` and electron-builder copies through
 * `package.json` `build.files`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveRuntimeExtensionEntry } from '../../core/pi-runtime.js'

const repoRoot = process.cwd()

// Plain ESM, so the build can run it before anything is compiled. Loaded by
// absolute URL because the compiled copy of this test lives in `.tests-dist`,
// where no `scripts/` directory exists.
const {
  stageRuntimeAssets,
}: { stageRuntimeAssets: (destinationRoot: string) => Promise<string[]> } =
  await import(
    pathToFileURL(path.join(repoRoot, 'scripts', 'stage-runtime-assets.mjs')).href
  )

// The runtime's own arithmetic, from its module directory
// (`team-runtime/index.ts`, the setup-mode branch of `before_agent_start`).
const SETUP_PROMPT_FROM_RUNTIME_DIR = ['..', 'setup', 'setup-agent.md']

function temporaryDirectory(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function buildFilesPatterns(): string[] {
  const packageJson: unknown = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  )
  const build = isRecord(packageJson) ? packageJson.build : undefined
  const files = isRecord(build) ? build.files : undefined
  assert.ok(Array.isArray(files) && files.every((item: unknown) => typeof item === 'string' || (isRecord(item) && (item.from === undefined || typeof item.from === 'string') && (item.to === undefined || typeof item.to === 'string') && (item.filter === undefined || typeof item.filter === 'string' || isStringList(item.filter)))), 'package.json build.files must contain electron-builder patterns or file sets')
  // This check protects dist-electron assets. Curated file sets have their own staging tests.
  return files.filter((item: unknown): item is string => typeof item === 'string')
}

/**
 * Whether electron-builder copies `relativePath` (relative to the app root).
 *
 * Its rule, from `app-builder-lib/out/util/filter.js` (`minimatchAll`):
 * patterns apply in order, and only a later `!` pattern can drop a file an
 * earlier pattern took. `node:path` `matchesGlob` stands in for its minimatch
 * (`{ dot: true }`). They agree while no pattern or asset path has a
 * dot-prefixed segment and no pattern is a bare directory name, which
 * electron-builder widens to `<name>/**\/*`. It also leaves out the default
 * exclusions electron-builder appends after these patterns
 * (`app-builder-lib/out/fileMatcher.js`); none of them matches a `.md` file
 * under `dist-electron`.
 */
function shippedByBuildFiles(relativePath: string, patterns: readonly string[]): boolean {
  let shipped = false
  for (const pattern of patterns) {
    const excludes = pattern.startsWith('!')
    if (shipped !== excludes) continue
    const matches = path.posix.matchesGlob(relativePath, excludes ? pattern.slice(1) : pattern)
    shipped = excludes ? !matches : matches
  }
  return shipped
}

test('a staged build puts the setup prompt where the compiled Team runtime looks', async () => {
  const buildRoot = temporaryDirectory('runtime-assets-compiled-')
  try {
    await stageRuntimeAssets(buildRoot)

    // Compiled, `team-runtime/index.ts` becomes `<build root>/team-runtime/index.js`.
    const setupPrompt = path.join(buildRoot, 'team-runtime', ...SETUP_PROMPT_FROM_RUNTIME_DIR)
    const relative = path.relative(buildRoot, setupPrompt)
    assert.ok(
      fs.existsSync(setupPrompt),
      `setup mode reads <build root>/${relative}, and staging did not put it there`,
    )
    assert.ok(
      fs.readFileSync(setupPrompt).equals(
        fs.readFileSync(path.join(repoRoot, 'setup', 'setup-agent.md')),
      ),
      `<build root>/${relative} must be a byte-for-byte copy of setup/setup-agent.md`,
    )
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true })
  }
})

test('the packaged app ships the setup prompt where its Team runtime looks', async () => {
  const appRoot = temporaryDirectory('runtime-assets-packaged-')
  try {
    // `electron:build` compiles into `dist-electron`, then stages into it.
    await stageRuntimeAssets(path.join(appRoot, 'dist-electron'))

    // The runtime the packaged app loads, as the desktop boot resolves it.
    const runtimeDir = path.dirname(resolveRuntimeExtensionEntry(appRoot))
    const setupPrompt = path.join(runtimeDir, ...SETUP_PROMPT_FROM_RUNTIME_DIR)
    const relative = path.relative(appRoot, setupPrompt).split(path.sep).join('/')

    assert.deepEqual(
      {
        inBuildTree: fs.existsSync(setupPrompt),
        matchedByBuildFiles: shippedByBuildFiles(relative, buildFilesPatterns()),
      },
      { inBuildTree: true, matchedByBuildFiles: true },
      `packaged setup mode reads <app>/${relative}; the build must produce it ` +
        'and package.json build.files must ship it',
    )
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true })
  }
})
