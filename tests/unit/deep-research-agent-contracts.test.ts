import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import type { AgentRosterEntry } from '../../core/types.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { createDeepResearchEvidenceOutputSchema } from '../../domains/deep-research/deep-research-evidence-output-schema.js'
import { createDeepResearchPlanOutputSchema } from '../../domains/deep-research/deep-research-plan-output-schema.js'
import { createDeepResearchQualityVerdictOutputSchema } from '../../domains/deep-research/deep-research-quality-output-schema.js'

test('evidence critic audits research readiness without requiring downstream publication artifacts', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'evidence-critic', 'evidence-critic.md'),
    'utf8',
  )

  assert.match(prompt, /audit runs before the writing and publication stages/)
  assert.match(prompt, /outputFormats.*downstream publication contract/s)
  assert.match(prompt, /Do not inspect, require, or issue findings\/corrections for/)
  assert.match(prompt, /final-report\.md.*final-report\.docx/s)
})

test('evidence output schema requires short contiguous source excerpts', () => {
  const schema = createDeepResearchEvidenceOutputSchema() as any
  const excerpt = schema.properties.findings.items.properties.evidenceLinks
    .items.properties.observedExcerpt

  assert.equal(excerpt.maxLength, 500)
  assert.match(excerpt.description, /contiguous passage/)
  assert.match(excerpt.description, /Never join separate regions or omit intervening words/)
})

test('research planner makes core-city and surrounding-region lanes non-overlapping', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'research-planner', 'research-planner.md'),
    'utf8',
  )

  assert.match(prompt, /regional\s+lane must explicitly cover communities outside the core city/)
  assert.match(prompt, /Never use\s+core-city subjects to satisfy the surrounding-region lane/)
})

test('research planner requires focused specialist methodology without fictional personas', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'research-planner', 'research-planner.md'),
    'utf8',
  )
  const reviewer = fs.readFileSync(
    path.join(
      process.cwd(),
      'agents',
      'research-plan-reviewer',
      'research-plan-reviewer.md',
    ),
    'utf8',
  )
  const schema = createDeepResearchPlanOutputSchema({
    maxDurationMinutes: 20,
    maxResearcherAgents: 4,
  }) as any
  const workerSchema = schema.properties.workerSpecs.items

  assert.match(prompt, /six complementary layers/)
  assert.match(prompt, /domain-expert analytical posture/)
  assert.match(prompt, /Do not invent a biography, personality, credentials/)
  assert.match(reviewer, /specialistStance.*workingDefinitions/s)
  assert.ok(workerSchema.required.includes('specialistStance'))
  assert.ok(workerSchema.required.includes('workingDefinitions'))
  assert.match(
    workerSchema.properties.specialistStance.description,
    /analytical posture/,
  )
})

test('research planning roles pin the bounded Terra and Sol policy', () => {
  const planner = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'research-planner', 'research-planner.md'),
    'utf8',
  )
  const reviewer = fs.readFileSync(
    path.join(
      process.cwd(),
      'agents',
      'research-plan-reviewer',
      'research-plan-reviewer.md',
    ),
    'utf8',
  )

  assert.match(planner, /provider: codex/u)
  assert.match(planner, /model: gpt-5\.6-terra/u)
  assert.match(planner, /thinking: medium/u)
  assert.match(planner, /tools: none/u)
  assert.match(reviewer, /provider: codex/u)
  assert.match(reviewer, /model: gpt-5\.6-sol/u)
  assert.match(reviewer, /thinking: high/u)
  assert.match(reviewer, /tools: none/u)
})

test('web researcher removes unverifiable correction candidates instead of carrying caveats forward', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'web-researcher', 'web-researcher.md'),
    'utf8',
  )

  assert.match(prompt, /every acceptance criterion is mandatory/)
  assert.match(prompt, /remove it and update coverage and conclusions consistently/)
  assert.match(prompt, /exact contiguous evidence link/)
})

test('web researcher keeps first-pass claims atomic and excerpt-supported', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'web-researcher', 'web-researcher.md'),
    'utf8',
  )

  assert.match(prompt, /first-pass evidence packet/)
  assert.match(prompt, /split material claims into atomic factual clauses/)
  assert.match(prompt, /every factual component.*exact contiguous evidence link/is)
  assert.match(prompt, /Do not aggregate capabilities.*linked excerpts/is)
})

test('evidence critic routes unsupported packet claims through packet repair', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'evidence-critic', 'evidence-critic.md'),
    'utf8',
  )

  assert.match(prompt, /claim itself contains unsupported factual components/is)
  assert.match(prompt, /use\s+`restructure_packet`/s)
  assert.match(prompt, /Reserve `resynthesize` for report-only mismatches/is)
  assert.match(
    prompt,
    /audit every material claim.*every task.*even after.*blocking/is,
  )
  assert.match(prompt, /do not short-circuit/is)
})

test('evidence critic does not mistake acquisition time for the approved freshness boundary', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'evidence-critic', 'evidence-critic.md'),
    'utf8',
  )

  assert.match(prompt, /`observedAt` is the evidence acquisition time/is)
  assert.match(
    prompt,
    /must not require `observedAt` to be at or before\s+`freshnessAsOf`/is,
  )
  assert.match(prompt, /historical cutoff.*publication date.*version.*archived content/is)
  assert.match(
    prompt,
    /current living documentation.*runtime observation.*satisfies.*default current-state freshness/is,
  )
  assert.match(
    prompt,
    /do not require.*publication or update date.*unless.*chronology.*historical cutoff/is,
  )
})

test('web researcher retains currently observed living documentation without inventing dates', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'web-researcher', 'web-researcher.md'),
    'utf8',
  )

  assert.match(
    prompt,
    /undated living documentation.*version observed during the run.*satisfies.*default current-state freshness/is,
  )
  assert.match(
    prompt,
    /never invent.*publication.*update.*date/is,
  )
})

test('evidence critic prompt states the machine contract without a fenced example', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'evidence-critic', 'evidence-critic.md'),
    'utf8',
  )
  const body = prompt.slice(prompt.indexOf('\n---', 4) + 4)

  assert.match(prompt, /Return exactly one strict `QualityVerdict` JSON object/)
  assert.match(prompt, /runtime supplies the approved plan.*quality packet.*deterministic/s)
  assert.match(prompt, /do not reopen them by filename/u)
  assert.equal(
    body.includes('```'),
    false,
    'The critic prompt must not show a fenced example while forbidding fences.',
  )
})

/** The backticked field names the prompt enumerates in one sentence. */
function fieldsListedAfter(prompt: string, marker: string): string[] {
  const start = prompt.indexOf(marker)
  assert.notEqual(start, -1, `the critic prompt must contain '${marker}'`)
  const sentence = prompt.slice(start + marker.length)
  const end = sentence.indexOf('.')
  assert.notEqual(end, -1, `'${marker}' must end in a sentence`)
  return [...sentence.slice(0, end).matchAll(/`([A-Za-z]+)`/g)]
    .map((match) => match[1] ?? '')
    .sort()
}

test('the critic prompt enumerates exactly the fields the provider schema requires', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'evidence-critic', 'evidence-critic.md'),
    'utf8',
  )
  const schema = createDeepResearchQualityVerdictOutputSchema()

  // The human instruction and the machine contract are the same contract. A
  // field one demands and the other omits is a critic asked for one shape and
  // graded on another.
  for (const [marker, ...path] of [
    ['Each finding must contain', 'properties', 'findings', 'items'],
    ['Each correction request must contain', 'properties', 'correctionRequests', 'items'],
  ] as const) {
    assert.deepEqual(
      fieldsListedAfter(prompt, marker),
      Object.keys(schemaAt(schema, ...path, 'properties')).sort(),
      `'${marker}' must list exactly the schema's required fields`,
    )
  }
  assert.match(prompt, /Every property listed here is required/)
})

test('evidence critic pins the bounded Terra runtime', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'evidence-critic', 'evidence-critic.md'),
    'utf8',
  )

  assert.match(prompt, /provider: codex/u)
  assert.match(prompt, /model: gpt-5\.6-terra/u)
})

/** Narrow one step of a JSON Schema without casting away its unknown shape. */
function schemaAt(
  value: unknown,
  ...path: readonly string[]
): Record<string, unknown> {
  let current = value
  for (const key of path) {
    assert.ok(isRecord(current), `Expected an object before '${key}'`)
    current = current[key]
  }
  assert.ok(isRecord(current), `Expected an object at '${path.join('.')}'`)
  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test('quality verdict output schema closes every union and forbids unknown fields', () => {
  const schema = createDeepResearchQualityVerdictOutputSchema()
  const finding = schemaAt(schema, 'properties', 'findings', 'items')
  const correction = schemaAt(schema, 'properties', 'correctionRequests', 'items')

  for (const object of [schemaAt(schema), finding, correction]) {
    assert.equal(object.type, 'object')
    assert.equal(object.additionalProperties, false)
    assert.deepEqual(object.required, Object.keys(schemaAt(object, 'properties')))
  }

  assert.deepEqual(schemaAt(schema, 'properties', 'decision').enum, ['APPROVE', 'REVISE', 'ESCALATE'])
  assert.deepEqual(schemaAt(schema, 'properties', 'correctionWave').enum, [0, 1, 2])
  assert.deepEqual(schemaAt(schema, 'properties', 'correctionRoute').enum, ['', 'research', 'synthesis'])
  assert.deepEqual(schemaAt(schema, 'properties', 'schemaVersion').enum, [1])
  assert.deepEqual(schemaAt(finding, 'properties', 'severity').enum, ['blocking', 'warning'])
  assert.deepEqual(schemaAt(finding, 'properties', 'code').enum, [
    'task_missing',
    'task_not_answered',
    'task_irrelevant',
    'required_metric_missing',
    'required_coverage_missing',
    'evidence_target_missing',
    'requirement_unresolved',
    'claim_unsupported',
    'source_unobserved',
    'source_not_independent',
    'primary_source_missing',
    'required_authority_missing',
    'contradiction_unresolved',
    'unresolved_question',
    'evidence_stale',
    'scope_mismatch',
    'report_evidence_mismatch',
    'decision_not_supported',
  ])
  assert.deepEqual(schemaAt(correction, 'properties', 'type').enum, [
    'new_research',
    'cross_verify',
    'verify_source',
    'resolve_contradiction',
    'remove_claim',
    'resynthesize',
    'restructure_packet',
  ])
  assert.deepEqual(schemaAt(correction, 'properties', 'impactScope').enum, ['local', 'global'])
})

const RESEARCH_TEAM_PATH = path.join(
  process.cwd(), 'teams', 'research-team', 'team.yaml',
)

/**
 * The runtime materializes evidence into these two agents' requests. A shipped
 * contract that still tells them to open a path, or a roster that still grants
 * them a filesystem tool, puts a second and conflicting instruction in front of
 * a live provider — which is how the section writers came back with refusals
 * naming files they could not read.
 */
const MATERIALIZED_AGENTS = ['research-section-writer', 'research-synthesizer'] as const

test('the runtime-fed research writers are granted no filesystem tool', () => {
  const parsed = parseTeamConfig(RESEARCH_TEAM_PATH)
  assert.deepEqual(parsed.errors, [])
  const config = parsed.config
  if (!config) assert.fail('the research team config did not parse')

  for (const agentName of MATERIALIZED_AGENTS) {
    const grantedTools: readonly string[] = config.agents.find(
      (candidate: AgentRosterEntry) => candidate.name === agentName,
    )?.tools ?? []
    assert.deepEqual(
      grantedTools,
      [],
      `'${agentName}' is still granted tools: ${JSON.stringify(grantedTools)}`,
    )
  }
})

test('the runtime-fed research writers are not told to open runtime artifact paths', () => {
  for (const agentName of MATERIALIZED_AGENTS) {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'agents', agentName, `${agentName}.md`),
      'utf8',
    )
    const frontmatterTools = /^tools:\s*(.+)$/mu.exec(source)?.[1]?.trim()
    assert.equal(
      frontmatterTools,
      'none',
      `'${agentName}' still declares tools: ${String(frontmatterTools)}`,
    )
    const readInstruction = source
      .split('\n')
      .find((line) => /\bread\b[^\n]*\bresearch\/[a-z-]+\//iu.test(line))
    assert.equal(
      readInstruction,
      undefined,
      `'${agentName}' still instructs the model to read a runtime artifact path: ${String(readInstruction)}`,
    )
  }
})

/**
 * The protocol that turns "all the bookstores in Ann Arbor" into a defensible
 * list.
 *
 * A run that asked for every bookstore claimed eleven while printing thirteen
 * rows and quietly dropped a shop it had successfully read. Each assertion
 * below pins one part of the repair: a ledger that no discovered candidate can
 * fall out of, typed extraction for the fields a directory repeats, one source
 * of truth for the rows and the count, and completeness wording the agent has
 * to earn.
 */
test('web researcher answers an exhaustive-list request from a reconciled candidate ledger', () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), 'agents', 'web-researcher', 'web-researcher.md'),
    'utf8',
  )

  // The intent that turns the protocol on, recognized before the first search.
  assert.match(prompt, /`all`, `every`, a `complete list`, a `directory`/u)
  assert.match(prompt, /before the first search/u)

  // One ledger, opened at discovery, with three terminal states and a reason.
  assert.match(prompt, /candidate ledger/u)
  assert.match(prompt, /End every candidate in exactly one state/u)
  assert.match(prompt, /`included` means in scope with every required field supported by observed content/u)
  assert.match(prompt, /`excluded` means[^.]*and the reason is recorded/u)
  assert.match(prompt, /`unresolved` means[^.]*a required field is still unsupported/u)

  // Repeated directory fields come from typed extraction, never from the eye.
  assert.match(prompt, /name, address, category, source URL, supporting excerpt/u)
  assert.match(prompt, /`research_web\.extract` with the acquired `contentId` and an explicit schema/u)
  assert.match(prompt, /leaves the candidate `unresolved`/u)

  // Reconciliation closes the ledger into the same three states, so a candidate
  // whose required field is still unsupported stays visible as `unresolved`
  // rather than being forced into an `included` or `excluded` it has not earned.
  assert.match(prompt, /Every candidate ends `included`, `excluded` with its reason, or `unresolved` naming what it still lacks/u)
  assert.match(prompt, /none may be left without a state/u)

  // The rows and the total come from the same set.
  assert.match(prompt, /the stated total is the number of those rows/u)
  assert.match(prompt, /Never state a total you arrived at separately/u)

  // Completeness is earned, and the fallback wording is truthful.
  assert.match(prompt, /Claim `all` or `complete` only after reconciling the ledger/u)
  assert.match(prompt, /I found 11 bookstores/u)
  assert.match(prompt, /name the completeness limit/u)

  // Every printed fact rests on observed content.
  assert.match(prompt, /transport success, a generic location page, and a cookie or consent page are evidence of nothing/u)

  // Budget follows the unsupported claim, not curiosity.
  assert.match(prompt, /`sourceValue=replaceable`/u)
  assert.match(prompt, /never draw browser or cloud budget/u)
  assert.match(prompt, /stop escalating as soon as that field is supported/u)
})
