import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { KNOWN_AGENT_PROVIDER_NAMES } from '../../domains/provider/provider-preflight.js'
import { isConfiguredProviderName } from '../../domains/provider/provider-settings.js'

/**
 * A shipped persona has to resolve on someone else's machine.
 *
 * `connection:<uuid>` names a row in the local Settings → AI Providers store.
 * The uuid is meaningful only in the installation that created it, so a persona
 * carrying one loads for its author and fails preflight for everyone else —
 * and because persona frontmatter outranks the team's own tiers, the team it
 * belongs to cannot override it back to something portable.
 */

const AGENTS_DIR = path.join(process.cwd(), 'agents')

function personaFiles(): string[] {
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(AGENTS_DIR, entry.name, `${entry.name}.md`))
    .filter((filePath) => fs.existsSync(filePath))
}

function frontmatterField(filePath: string, key: string): string | undefined {
  const source = fs.readFileSync(filePath, 'utf8')
  if (!source.startsWith('---')) return undefined
  const end = source.indexOf('\n---', 3)
  if (end < 0) return undefined
  return source
    .slice(0, end)
    .split('\n')
    .find((line) => line.startsWith(`${key}:`))
    ?.slice(`${key}:`.length)
    .trim()
    .replace(/^["']|["']$/g, '')
}

function frontmatterProvider(filePath: string): string | undefined {
  return frontmatterField(filePath, 'provider')
}

test('no shipped agent persona pins a machine-local provider connection', () => {
  const pinned = personaFiles()
    .map((filePath) => ({ filePath, provider: frontmatterProvider(filePath) }))
    .filter((entry) => entry.provider?.startsWith('connection:'))
    .map((entry) => `${path.relative(process.cwd(), entry.filePath)} → ${entry.provider}`)

  assert.deepEqual(
    pinned,
    [],
    'a persona may only name a portable provider; a `connection:<uuid>` is a ' +
      'local Settings record and resolves on one installation only',
  )
})

/**
 * A provider name nothing registers cannot be supplied by any installation.
 *
 * `KNOWN_AGENT_PROVIDER_NAMES` is the whole set preflight accepts; a persona
 * naming anything else fails with "references unknown provider '<name>'" on
 * every machine, so it is unrunnable rather than merely unconfigured. A
 * `connection:<uuid>` is a different fault and is covered by the test above.
 */
test('no shipped agent persona names a provider the application does not register', () => {
  const known = new Set<string>(KNOWN_AGENT_PROVIDER_NAMES)
  const unknown = personaFiles().flatMap((filePath) => {
    const provider = frontmatterProvider(filePath)
    if (!provider || known.has(provider) || isConfiguredProviderName(provider)) return []
    return [`${path.relative(process.cwd(), filePath)} → ${provider}`]
  })

  assert.deepEqual(
    unknown,
    [],
    'a persona may only name a provider preflight knows; anything else refuses ' +
      'to start on every installation',
  )
})

/**
 * A persona is addressed by its folder name, never by the one it declares.
 *
 * `loadAgent` takes the runtime name from the team roster entry, `listAgents`
 * names each Create row after its directory, and the browser, acquisition,
 * Word and Excel policies resolve `agents/<folder>/<folder>.md` straight from
 * a path. Nothing in the application reads a bundled persona's frontmatter
 * `name`, so a declared name that differs from its folder is a second identity
 * that resolves nowhere — `pragmatist` shipped as `name: pragmatist2` while
 * three rosters addressed it as `pragmatist`. The `vc-*` pack is the same
 * fault at scale: its folders carry the prefix precisely to avoid colliding
 * with the unprefixed library agents, and its frontmatter then declares the
 * unprefixed names anyway, so `agents/vc-pattern-matcher` and
 * `agents/pattern-matcher` both claim to be `pattern-matcher`.
 *
 * The application already enforces exactly this rule for the agents it
 * generates: `assertGeneratedIdentity` rejects a persona whose frontmatter
 * name is not the planned name, and `planned-agent-persistence` refuses a
 * staged package whose declared name is not the one on its receipt. The
 * bundled library is held to the rule the generator already writes down.
 *
 * A persona that declares no `name` — `resource-architect` has no frontmatter
 * at all, `workflow-architect` declares only a provider and model — states no
 * second identity and is left alone.
 */
test('no shipped agent persona declares a name other than its folder name', () => {
  const misnamed = personaFiles().flatMap((filePath) => {
    const folder = path.basename(path.dirname(filePath))
    const declared = frontmatterField(filePath, 'name')
    if (declared === undefined || declared === folder) return []
    return [`agents/${folder} → ${declared}`]
  })

  assert.deepEqual(
    misnamed,
    [],
    'every roster, catalog and policy addresses a persona by its folder; a ' +
      'frontmatter `name` that says anything else names an agent that does ' +
      'not exist',
  )
})

/**
 * `personaFiles()` can only check a folder it can find a persona in, so a
 * folder it cannot read is a hole in every rule above rather than a neutral
 * skip. Two ways that happens, and both are silent: a persona whose file does
 * not match its folder never loads — `listAgents` resolves
 * `agents/<name>/<name>.md` and nothing else — so it vanishes from Create and
 * from the sibling checks at the same moment; and a folder can hold a persona
 * nested somewhere the loader never looks, which is the shape the five `rnd-*`
 * folders are in today. Each keeps its persona at `pi/<short-name>.md` and
 * declares the unprefixed name there, so they are simultaneously unreachable
 * and in breach of the rule directly above this one.
 *
 * Pinning the exact set is what makes the gap visible. A sixth unreadable
 * folder fails here instead of quietly shrinking the other tests' coverage,
 * and repairing one of these five also fails here, which is the prompt to
 * delete it from the list rather than leave a stale exemption behind.
 */
const FOLDERS_WITHOUT_A_LOADABLE_PERSONA = [
  'rnd-application-domain-scanner',
  'rnd-capability-deconstructor',
  'rnd-competitive-alternative-mapper',
  'rnd-problem-solution-fit-assessor',
  'rnd-research-question-architect',
]

test('every agent folder holds a persona the loader can read, except the ones pinned here', () => {
  const unreadable = fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !fs.existsSync(path.join(AGENTS_DIR, entry.name, `${entry.name}.md`)))
    .map((entry) => entry.name)
    .sort()

  assert.deepEqual(
    unreadable,
    FOLDERS_WITHOUT_A_LOADABLE_PERSONA,
    'a folder with no `<folder>/<folder>.md` is invisible to the agents list ' +
      'and to every other check in this file; add it here with a reason, or ' +
      'give it a persona the loader can read',
  )
})
