import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  ResearchEvidenceGraph,
  ResearchPublicationAudit,
} from '../../contracts/deep-research.js'
import { registerProvider } from '../../providers/index.js'
import type {
  ProviderExecuteOptions,
  ProviderResult,
} from '../../providers/types.js'
import { runWorkflow } from '../../workflows/runner.js'
import {
  makeEvidenceGraph,
  makeGraphClaim,
  makeGraphSource,
} from '../unit/deep-research-citation-fixtures.js'

const FIXTURE_PROVIDER = 'citation-canonicalization-fixture'
const KNOWN = 'https://regulator.example/report'
const UNKNOWN = 'https://invented.example/hallucination'

interface FixtureScript {
  readonly researchPackage: string
  readonly editorialDraft: string
  readonly graphText: string
}

// The provider registry accepts one registration per name, so a single
// registration reads whichever script the running test installed.
let activeScript: FixtureScript | undefined

registerProvider({
  name: FIXTURE_PROVIDER,
  execute: async (options: ProviderExecuteOptions): Promise<ProviderResult> => {
    const script = activeScript
    if (!script) throw new Error('No citation fixture script is active.')
    const role = fixtureRole(options)
    if (role !== 'research') return fixtureResult(script.editorialDraft)
    // Both provenance artifacts originate from the research step; the evidence
    // graph is written as a real file the step declares.
    if (options.cwd) {
      const graphPath = path.join(
        options.cwd,
        'research',
        'evidence-graph',
        'current.json',
      )
      fs.mkdirSync(path.dirname(graphPath), { recursive: true })
      fs.writeFileSync(graphPath, script.graphText)
    }
    return fixtureResult(script.researchPackage)
  },
})

interface PublishOutcome {
  readonly status: string
  readonly error?: string | undefined
  readonly finalReport?: string | undefined
  /** Exact bytes of the published `final-report.md` artifact. */
  readonly finalReportBytes?: Buffer | undefined
  readonly finalDraft?: string | undefined
  readonly audit?: ResearchPublicationAudit | undefined
  readonly docx?: Buffer | undefined
  readonly excel?: Buffer | undefined
  /** Exact bytes the publish transform handed to the document generator. */
  readonly transformInput?: string | undefined
}

test('a safe unknown-link repair publishes canonical Markdown and DOCX', async () => {
  const outcome = await publish({
    researchPackage: researchPackage(),
    editorialDraft: [
      '# Final report',
      '',
      `Adoption reached 18% according to [the filing](${KNOWN}).`,
      '',
      `Growth was [reportedly strong](${UNKNOWN}) last year.`,
      '',
      '## References',
      '',
      `- [Model-authored entry](${UNKNOWN})`,
      '',
    ].join('\n'),
  })

  assert.equal(outcome.status, 'completed', outcome.error)
  assert.equal(outcome.audit?.decision, 'APPROVE')
  assert.deepEqual(outcome.audit?.violations, [])

  // The unknown URL is gone from both published artifacts, label intact.
  assert.doesNotMatch(outcome.finalReport ?? '', /invented\.example/u)
  assert.match(outcome.finalReport ?? '', /Growth was reportedly strong last year\./u)
  assert.match(outcome.finalReport ?? '', /\[the filing\]\(https:\/\/regulator\.example\/report\)/u)
  assert.equal(outcome.finalReport?.match(/^## Sources$/gmu)?.length, 1)
  assert.match(outcome.finalReport ?? '', /- \[Regulator Report\]\(https:\/\/regulator\.example\/report\)/u)

  // The editorial draft is preserved for comparison and recovery.
  assert.match(outcome.finalDraft ?? '', /invented\.example/u)

  // The repair is recorded rather than silently applied. The second unknown
  // URL vanished with its whole source section, which is recorded separately.
  assert.deepEqual(
    outcome.audit?.canonicalization?.removedUnknownUrls.map((entry) => entry.kind),
    ['inline_link'],
  )
  assert.deepEqual(
    [...(outcome.audit?.canonicalization?.removedSourceSectionHeadings ?? [])],
    ['References'],
  )
  assert.deepEqual(
    [...(outcome.audit?.canonicalization?.publicationUrlInventory ?? [])],
    [...(outcome.audit?.canonicalization?.graphUrlBaseline ?? [])],
  )
  assert.equal(outcome.docx?.subarray(0, 2).toString('ascii'), 'PK')
})

test('losing the only citation for a numeric claim writes the audit and fails publication', async () => {
  const outcome = await publish({
    researchPackage: researchPackage(),
    editorialDraft: [
      '# Final report',
      '',
      `Adoption reached 18% according to [an invented source](${UNKNOWN}).`,
      '',
      '## Sources',
      '',
      `- [Regulator Report](${KNOWN})`,
      '',
    ].join('\n'),
  })

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.error ?? '', /numeric claim paragraph/u)
  // Failure evidence survives the throw.
  assert.equal(outcome.audit?.decision, 'REVISE')
  assert.ok(
    outcome.audit?.violations.some(
      (entry) => entry.code === 'numeric_claim_uncited',
    ),
    'expected numeric_claim_uncited',
  )
})

test('a supported claim backed by a non-usable source fails before publication', async () => {
  const outcome = await publish({
    researchPackage: researchPackage(),
    editorialDraft: `# Final report\n\nAdoption reached 18% via [the filing](${KNOWN}).\n`,
    evidenceGraph: makeEvidenceGraph({
      sources: [makeGraphSource({ status: 'stale' })],
    }),
  })

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.error ?? '', /status is 'stale'/u)
  assert.equal(outcome.finalReport, undefined)
})

test('a malformed evidence graph fails closed instead of publishing unrepaired', async () => {
  const outcome = await publish({
    researchPackage: researchPackage(),
    editorialDraft: `# Final report\n\nAdoption reached 18% via [bad](${UNKNOWN}).\n`,
    evidenceGraphText: JSON.stringify({ schemaVersion: 1, planId: 'plan-one' }),
  })

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.finalReport, undefined)
  assert.doesNotMatch(outcome.error ?? '', /numeric claim/u)
})

test('URL-backed footnotes become inline links in Markdown and DOCX', async () => {
  const outcome = await publish({
    researchPackage: researchPackage(),
    editorialDraft: [
      '# Final report',
      '',
      'Adoption reached 18% in the reviewed period[^1].',
      '',
      `[^1]: [the filing](${KNOWN})`,
      '',
    ].join('\n'),
  })

  assert.equal(outcome.status, 'completed', outcome.error)
  assert.equal(outcome.audit?.decision, 'APPROVE')
  // The footnote became an inline link, which the numeric audit recognizes.
  assert.match(outcome.finalReport ?? '', /\[the filing\]\(https:\/\/regulator\.example\/report\)/u)
  assert.doesNotMatch(outcome.finalReport ?? '', /\[\^1\]:/u)
  assert.ok(
    outcome.audit?.numericClaimParagraphs.every((entry) => entry.cited),
    'numeric paragraphs remain cited',
  )
})

test('a reference-style citation keeps a numeric claim publishable', async () => {
  const outcome = await publish({
    researchPackage: researchPackage(),
    editorialDraft: [
      '# Final report',
      '',
      'Adoption reached 18% according to [the filing][r1].',
      '',
      `[r1]: ${KNOWN}`,
      '',
    ].join('\n'),
  })

  assert.equal(outcome.status, 'completed', outcome.error)
  assert.equal(outcome.audit?.decision, 'APPROVE')
  assert.match(outcome.finalReport ?? '', /\[the filing\]\[r1\]/u)
  assert.match(outcome.finalReport ?? '', /\[r1\]: https:\/\/regulator\.example\/report/u)
  assert.ok(
    outcome.audit?.numericClaimParagraphs.every((entry) => entry.cited),
    'reference-style numeric paragraphs stay cited',
  )
})

test('a duplicate reference definition resolves first-wins through publication', async () => {
  const outcome = await publish({
    researchPackage: researchPackage(),
    editorialDraft: [
      '# Final report',
      '',
      'Adoption reached 18% according to [the filing][r1].',
      '',
      `[r1]: ${KNOWN}`,
      '',
      `[r1]: ${UNKNOWN}`,
      '',
    ].join('\n'),
  })

  assert.equal(outcome.status, 'completed', outcome.error)
  assert.equal(outcome.audit?.decision, 'APPROVE')
  // The live citation survives; the dead duplicate does not.
  assert.match(
    outcome.finalReport ?? '',
    /Adoption reached 18% according to \[the filing\]\[r1\]\./u,
  )
  assert.equal(outcome.finalReport?.match(/\[r1\]:/gu)?.length, 1)
  assert.doesNotMatch(outcome.finalReport ?? '', /invented\.example/u)
})

test('paren-bearing graph URLs publish intact through the whole journey', async () => {
  const url = 'https://en.wikipedia.org/wiki/Widget_(computing)'
  const outcome = await publish({
    researchPackage: `# Research package\n\nAdoption reached 18% via the wiki ([widget](${url})).\n`,
    editorialDraft: [
      '# Final report',
      '',
      `Adoption reached 18% according to [the widget](${url}).`,
      '',
    ].join('\n'),
    evidenceGraph: makeEvidenceGraph({
      sources: [makeGraphSource({ canonicalUrl: url, title: 'Widget Study' })],
      claims: [
        makeGraphClaim({
          statement: 'Adoption reached 18% in the reviewed period.',
          sourceIds: ['S1'],
          supportingSourceIds: ['S1'],
        }),
      ],
    }),
  })

  assert.equal(outcome.status, 'completed', outcome.error)
  assert.equal(outcome.audit?.decision, 'APPROVE')
  assert.deepEqual(outcome.audit?.violations, [])
  assert.match(
    outcome.finalReport ?? '',
    /\[the widget\]\(<https:\/\/en\.wikipedia\.org\/wiki\/Widget_\(computing\)>\)/u,
  )
  assert.match(
    outcome.finalReport ?? '',
    /- \[Widget Study\]\(<https:\/\/en\.wikipedia\.org\/wiki\/Widget_\(computing\)>\)/u,
  )
  assert.deepEqual(
    [...(outcome.audit?.canonicalization?.publicationUrlInventory ?? [])],
    [url],
  )
})

test('outputSha256 matches the exact shipped publication bytes', async () => {
  const outcome = await publish({
    researchPackage: researchPackage(),
    editorialDraft: `# Final report\n\nAdoption reached 18% according to [the filing](${KNOWN}).\n`,
  })

  assert.equal(outcome.status, 'completed', outcome.error)
  assert.ok(outcome.finalReportBytes, 'expected a published report artifact')
  assert.equal(
    outcome.audit?.canonicalization?.outputSha256,
    createHash('sha256').update(outcome.finalReportBytes!).digest('hex'),
  )
})

test('provenance without an evidence graph keeps legacy publication behavior', async () => {
  const draft = [
    '# Final report',
    '',
    `Adoption reached 18% according to [the filing](${KNOWN}).`,
    '',
  ].join('\n')
  const outcome = await publish({
    // Legacy auditing compares the package against the draft directly, so the
    // package must not carry a URL the draft lacks.
    researchPackage: `# Research package\n\nAdoption reached 18% via ${KNOWN}.\n`,
    editorialDraft: draft,
    omitEvidenceGraph: true,
  })

  assert.equal(outcome.status, 'completed', outcome.error)
  assert.equal(outcome.audit?.canonicalization, undefined)
  // No generated Sources section, no rewriting: bytes pass through untouched.
  assert.doesNotMatch(outcome.finalReport ?? '', /^## Sources$/mu)
  assert.equal(outcome.finalReport?.trim(), draft.trim())
})

test('generate_excel with provenance and a graph receives unchanged input', async () => {
  const workbook = [
    '# Findings',
    '',
    '| Source | Link |',
    '| --- | --- |',
    `| Regulator | ${KNOWN} |`,
    `| Unverified | ${UNKNOWN} |`,
    '',
  ].join('\n')
  const outcome = await publish({
    researchPackage: `# Research package\n\nThe filing is at ${KNOWN} beside ${UNKNOWN}.\n`,
    editorialDraft: workbook,
    transform: 'generate_excel',
  })

  assert.equal(outcome.status, 'completed', outcome.error)
  assert.equal(outcome.excel?.subarray(0, 2).toString('ascii'), 'PK')
  // The canonicalizer never ran: no summary, the unknown URL was not stripped,
  // no Sources section was appended, and the bytes passed through untouched.
  assert.equal(outcome.audit?.canonicalization, undefined)
  assert.match(outcome.transformInput ?? '', /invented\.example/u)
  assert.doesNotMatch(outcome.transformInput ?? '', /^## Sources$/mu)
  assert.equal(outcome.transformInput?.trim(), workbook.trim())
})

function researchPackage(): string {
  return [
    '# Research package',
    '',
    `Adoption reached 18% according to [the filing](${KNOWN}).`,
    '',
    `The editorial draft also cited ${UNKNOWN}.`,
    '',
    '## Sources',
    '',
    `- [Regulator Report](${KNOWN})`,
    '',
  ].join('\n')
}

async function publish(params: {
  researchPackage: string
  editorialDraft: string
  evidenceGraph?: ResearchEvidenceGraph
  evidenceGraphText?: string
  omitEvidenceGraph?: boolean
  transform?: 'markdown_to_docx' | 'generate_excel'
}): Promise<PublishOutcome> {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'citation-canonicalization-')),
  )
  try {
    const graphText =
      params.evidenceGraphText ??
      JSON.stringify(
        params.evidenceGraph ??
          makeEvidenceGraph({
            claims: [
              makeGraphClaim({
                statement: 'Adoption reached 18% in the reviewed period.',
              }),
            ],
          }),
      )
    activeScript = {
      researchPackage: params.researchPackage,
      editorialDraft: params.editorialDraft,
      graphText,
    }

    const teamPath = createFixtureTeam(root)
    const templatePath = path.join(root, 'citation-publication.yaml')
    const transform = params.transform ?? 'markdown_to_docx'
    const isExcel = transform === 'generate_excel'
    const resultArtifact = isExcel ? 'final-report.xlsx' : 'final-report.md'
    fs.writeFileSync(
      templatePath,
      `
workflow:
  id: citation-publication
  steps:
    - id: research
      type: agent
      team: citation-fixture-team
      agent: research
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: research-package.md
      result_artifacts:
        - research/evidence-graph/current.json
      recovery_policy: manual
    - id: editorial
      type: agent
      team: citation-fixture-team
      agent: editor
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      recovery_policy: manual
      handoff:
        from_step: research
        from_artifact: research-package.md
        to_artifact: incoming-brief.md
    - id: publish
      type: transform
      transform: ${transform}
      input_artifact: final-draft.md
      result_artifact: ${resultArtifact}
      result_artifacts:
${isExcel ? '' : '        - final-report.docx\n'}        - publication-audit.json
      recovery_policy: idempotent
      handoff:
        from_step: editorial
        from_artifact: final-draft.md
        to_artifact: final-draft.md
      provenance_handoff:
        from_step: research
        from_artifact: research-package.md
${params.omitEvidenceGraph ? '' : '        evidence_graph_artifact: research/evidence-graph/current.json\n'}        audit_artifact: publication-audit.json
  output:
    from_step: publish
    artifact: ${resultArtifact}
`,
    )

    // The transform throws on REVISE and on canonicalization errors; artifacts
    // written before the throw must still be observable.
    let status = 'failed'
    let error: string | undefined
    try {
      const result = await runWorkflow(runOptions({
        templatePath,
        teamPath,
        workspacePath: path.join(root, 'workspace'),
      }))
      status = result.status
      error = result.summary
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    }

    const files = walk(path.join(root, 'workspace'))
    return {
      status,
      error,
      finalReport: readTextIfPresent(files, 'final-report.md'),
      finalReportBytes: readBufferIfPresent(files, 'final-report.md'),
      finalDraft: readEditorialDraft(files),
      audit: readAuditIfPresent(files),
      docx: readBufferIfPresent(files, 'final-report.docx'),
      excel: readBufferIfPresent(files, 'final-report.xlsx'),
      transformInput: readPublishInput(files),
    }
  } finally {
    activeScript = undefined
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function runOptions(params: {
  templatePath: string
  teamPath: string
  workspacePath: string
}) {
  return {
      workflowEntry: {
        name: 'citation-publication',
        template_path: params.templatePath,
      },
      teamRegistry: new Map([
        [
          'citation-fixture-team',
          {
            name: 'citation-fixture-team',
            type: 'team' as const,
            team_path: params.teamPath,
            input_artifact: 'incoming-brief.md',
            output_artifact: 'final-draft.md',
          },
        ],
      ]),
      brief: '# Brief\n\nProduce the report.\n',
      workspacePath: params.workspacePath,
      spawnDepth: 0,
      persistenceMode: 'required' as const,
      taskId: 'task-citation',
      productSessionId: 'session-citation',
      rootSessionId: 'root-citation',
      executionAttemptId: 'attempt-citation',
  }
}

function createFixtureTeam(root: string): string {
  const teamPath = path.join(root, 'citation-fixture-team')
  for (const agentName of ['research', 'editor']) {
    const agentPath = path.join(teamPath, 'agents', agentName, `${agentName}.md`)
    fs.mkdirSync(path.dirname(agentPath), { recursive: true })
    // Each fixture agent names the pair it runs with; the team names none.
    fs.writeFileSync(
      agentPath,
      `---\nprovider: ${FIXTURE_PROVIDER}\nmodel: fixture-model\nthinking: low\n---\n\nFIXTURE_ROLE:${agentName}\n`,
    )
  }
  fs.writeFileSync(
    path.join(teamPath, 'team.yaml'),
    `
team:
  name: citation-fixture-team
  description: Deterministic fixture for citation canonicalization.
  version: "1.0.0"
workspace:
  path: workspace
  watch: false
workflow:
  entry_level: writing-chain
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
  output_contract:
    artifacts:
      - path: final-draft.md
        required: true
    completion_artifact: final-draft.md
agents:
  - name: research
    type: agent
    role: Emits the approved research package and evidence graph.
    tier: strategic
    tools: []
    agent_file: agents/research/research.md
    experience_enabled: false
  - name: editor
    type: agent
    role: Emits the editorial draft.
    tier: execution
    tools: []
    agent_file: agents/editor/editor.md
    produces:
      - path: final-draft.md
    experience_enabled: false
levels:
  - id: writing-chain
    name: Writing Chain
    order: 0
    stage:
      type: chain
      sequence:
        - research
        - editor
      config:
        output:
          format: final-draft.md
          user_review: false
gates:
  - from: writing-chain
    to: done
    condition:
      type: artifact_exists
      artifact: final-draft.md
`,
  )
  return teamPath
}

function fixtureRole(options: ProviderExecuteOptions): string {
  const match = /FIXTURE_ROLE:([a-z-]+)/u.exec(options.systemPrompt)
  if (!match) throw new Error('Deterministic provider received no fixture role.')
  return match[1]!
}

function fixtureResult(text: string): ProviderResult {
  return {
    text,
    cost: 0,
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    model: 'fixture-model',
    costTracked: true,
    costSource: 'zero_cost',
  }
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const output: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...walk(full))
    else output.push(full)
  }
  return output
}

function findFile(files: readonly string[], suffix: string): string | undefined {
  return files.find((file) => path.basename(file) === suffix)
}

function readTextIfPresent(
  files: readonly string[],
  suffix: string,
): string | undefined {
  const file = findFile(files, suffix)
  return file ? fs.readFileSync(file, 'utf8') : undefined
}

function readBufferIfPresent(
  files: readonly string[],
  suffix: string,
): Buffer | undefined {
  const file = findFile(files, suffix)
  return file ? fs.readFileSync(file) : undefined
}

/**
 * Both the editorial step and the publish transform write a `final-draft.md`
 * into their own assignment directory. Only the publish assignment also holds
 * the transform's own outputs, which is how the two are told apart.
 */
function isPublishAssignment(files: readonly string[], draft: string): boolean {
  const directory = path.dirname(draft)
  return files.some(
    (candidate) =>
      path.dirname(candidate) === directory &&
      (path.basename(candidate) === 'publication-audit.json' ||
        path.basename(candidate).startsWith('final-report.')),
  )
}

function findDraft(
  files: readonly string[],
  wantPublish: boolean,
): string | undefined {
  const file = files.find(
    (candidate) =>
      path.basename(candidate) === 'final-draft.md' &&
      isPublishAssignment(files, candidate) === wantPublish,
  )
  return file ? fs.readFileSync(file, 'utf8') : undefined
}

/** The editorial original, which canonicalization must leave untouched. */
function readEditorialDraft(files: readonly string[]): string | undefined {
  return findDraft(files, false)
}

/** The exact bytes the publish transform handed to the document generator. */
function readPublishInput(files: readonly string[]): string | undefined {
  return findDraft(files, true)
}

function readAuditIfPresent(
  files: readonly string[],
): ResearchPublicationAudit | undefined {
  const text = readTextIfPresent(files, 'publication-audit.json')
  if (text === undefined) return undefined
  const parsed: unknown = JSON.parse(text)
  return isAudit(parsed) ? parsed : undefined
}

function isAudit(value: unknown): value is ResearchPublicationAudit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'decision' in value &&
    'violations' in value
  )
}
