import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  EvidencePacket,
  ResearchExecutionPolicy,
  ResearchPlan,
  ResearchSection,
  ResearchTask,
  ResearchWorkerSpec,
  SourceRecord,
} from '../../contracts/deep-research.js'
import {
  approveResearchPlan,
  assertResearchPlanApproved,
} from '../../domains/deep-research/deep-research-approval.js'
import { finalizeDeepResearchEvidenceWave } from '../../domains/deep-research/deep-research-pipeline-adapter.js'
import { hashResearchValue } from '../../domains/deep-research/deep-research-worker-policy.js'
import { createPipelineTool } from '../../engines/pipeline.js'
import { createChainTool } from '../../engines/chain.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import type { PlanState, PlanTask } from '../../parsers/plan-parser.js'
import { parsePlan } from '../../parsers/plan-parser.js'
import type {
  ProviderExecuteOptions,
  ProviderResult,
} from '../../providers/types.js'
import { registerProvider } from '../../providers/index.js'
import { buildDeepResearchSynthesisBundle } from '../../domains/deep-research/deep-research-synthesis-bundle.js'
import { ProviderRequestBudgetError } from '../../domains/provider/provider-request-budget.js'
import { STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'
import {
  makeEvidencePacket,
  makePlan,
  makeSource,
  makeWorkerSpec,
  TEST_TIME,
} from '../unit/deep-research-fixtures.js'

const REPO_ROOT = process.cwd()
const RESEARCH_TEAM_ROOT = path.join(REPO_ROOT, 'teams', 'research-team')

const SECTION_POLICY: ResearchExecutionPolicy = {
  schemaVersion: 1,
  complexity: 'complex',
  complexityRationale:
    'Two substantial sections are drafted in parallel before one synthesis pass.',
  searchBreadth: 'broad',
  maxCostUsd: 20,
  evidenceTargets: {
    minimumSupportedClaims: 1,
    minimumIndependentSourcesPerConsequentialClaim: 2,
    crossVerifyConsequentialClaims: true,
  },
  stopping: {
    minimumExpectedInformationGain: 50,
    maximumCorrectionWaves: 2,
  },
  synthesis: {
    mode: 'section_dossiers',
    maximumParallelSections: 2,
  },
}

const SINGLE_PASS_POLICY: ResearchExecutionPolicy = {
  ...SECTION_POLICY,
  complexity: 'standard',
  complexityRationale: 'One synthesizer owns the whole report.',
  synthesis: { mode: 'single_pass', maximumParallelSections: 1 },
}

/**
 * A section-dossier run is a cross-layer capability: the runtime materializes
 * each writer's evidence, validates what comes back, and hands the synthesizer
 * one bounded bundle. This is its coherent user journey — a two-section report
 * reaching synthesis with evidence-bound drafts and an in-budget request.
 *
 * The fake providers never see the assignment directory. They answer only from
 * the request they are given, which is what makes "the writer received a local
 * path instead of its evidence" observable rather than invisible.
 */
test('a section-dossier run drafts from materialized evidence and synthesizes from one bounded bundle', async () => {
  await withSectionRun(async (assignmentPath) => {
    const writerRequests: ProviderExecuteOptions[] = []
    const writerProvider = registerCapturingProvider(
      'section-writer-journey',
      writerRequests,
      (options) => answerSectionFromRequest(options.userMessage),
    )

    const draftResult = await runDraftSectionsStage(assignmentPath, writerProvider)

    assert.match(toolText(draftResult), /Pipeline complete/u)
    assert.equal(writerRequests.length, 2)

    // Materialization: the request carries the dossier's own evidence, not a
    // path the model would have to open for itself.
    for (const request of writerRequests) {
      const dossier = readMaterializedDossier(request.userMessage)
      if (!dossier) {
        assert.fail('the section writer request carried no materialized dossier payload')
      }
      assert.ok(dossier.claims.length > 0, 'the materialized dossier carried no claims')
      assert.ok(
        dossier.sources.some((source) => source.canonicalUrl.startsWith('https://')),
        'the materialized dossier carried no source URLs',
      )
    }

    for (const sectionId of ['section-one', 'section-two']) {
      assert.match(
        readDraft(assignmentPath, sectionId),
        /https:\/\//u,
        `${sectionId} draft cited no source`,
      )
    }

    const synthesisRequests: ProviderExecuteOptions[] = []
    const synthesizerProvider = registerCapturingProvider(
      'synthesizer-journey',
      synthesisRequests,
      () => '# Report\n\nSynthesized from the bundle.\n',
    )

    const synthesisResult = await runSynthesizeEvidenceStage(
      assignmentPath,
      synthesizerProvider,
    )

    assert.match(toolText(synthesisResult), /complete/iu)
    assert.equal(synthesisRequests.length, 1)
    const [synthesisRequest] = synthesisRequests
    if (!synthesisRequest) assert.fail('the synthesizer was never dispatched')
    assert.match(
      synthesisRequest.userMessage,
      /Evidence-bound section draft/u,
      'the synthesis bundle carried no validated section drafts',
    )
    assert.match(
      synthesisRequest.userMessage,
      /section-one/u,
      'the synthesis bundle named no approved section',
    )
    const requestBytes = Buffer.byteLength(
      `${synthesisRequest.systemPrompt}\n${synthesisRequest.userMessage}`,
      'utf8',
    )
    assert.ok(
      requestBytes < 588_000,
      `the synthesis request was ${requestBytes} bytes, which a 200k-token ` +
      'window reserving 32k for the answer cannot admit',
    )
  })
})

test('a section writer refusal is rejected instead of persisted as a completed draft', async () => {
  await withSectionRun(async (assignmentPath) => {
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-refusal',
      requests,
      (options) =>
        readSectionIdFromRequest(options.userMessage) === 'section-two'
          ? 'I was not given access to the dossier file for this section, so I ' +
            'cannot draft it. Please supply the dossier contents and I will proceed.'
          : answerSectionFromRequest(options.userMessage),
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-two')),
      false,
      'a refusal was persisted as the section draft',
    )
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'failed')
    assert.match(toolText(result), /section-two|T2/u)
  })
})

test('an evidence-empty correction dossier persists a limitation section instead of failing drafting', async () => {
  await withSectionRun(async (assignmentPath) => {
    writeEvidenceEmptySectionDossier(assignmentPath, 'section-two')
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-empty-correction',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: [],
          sourceIds: [],
          markdown:
            '## Retention\n\nNo usable evidence survived the correction boundary, so this section remains unresolved.',
        })
      },
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    const sectionRequest = requests.find(
      (request) => readSectionIdFromRequest(request.userMessage) === 'section-two',
    )
    if (!sectionRequest) assert.fail('the section-two writer was never dispatched')
    // Neither array has anything this dossier could fill, so the skeleton must
    // show both empty rather than a placeholder identifier to copy back.
    assert.match(
      sectionRequest.userMessage,
      /"claimIds":\[\],"sourceIds":\[\]/u,
      'the skeleton showed placeholder identifiers an empty dossier cannot fill',
    )
    assert.match(toolText(result), /Pipeline complete/u)
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'completed')
    assert.match(
      readDraft(assignmentPath, 'section-two'),
      /No usable evidence survived/u,
    )
  })
})

test('a dossier whose claims carry no sources still publishes a limitation draft', async () => {
  // A section whose findings are all sourceless (an `uncertainty` claim
  // carries no evidence links) builds a dossier with claims and an empty
  // source list, because the dossier derives its sources from the union of the
  // claim source ids. Demanding a source identifier from the draft would
  // reject every answer such a section can produce and send `on_failure:
  // retry` straight back into the same wall.
  await withSectionRun(async (assignmentPath) => {
    writeSourcelessSectionDossier(assignmentPath, 'section-two')
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-sourceless-claims',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: dossier.claims.map((claim) => claim.claimId),
          sourceIds: [],
          markdown:
            '## Retention\n\nThe evidence records an open uncertainty and no ' +
            'observed source, so this section states the limitation rather ' +
            'than a measured result.',
        })
      },
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    const sectionRequest = requests.find(
      (request) => readSectionIdFromRequest(request.userMessage) === 'section-two',
    )
    const materialized = sectionRequest
      ? readMaterializedDossier(sectionRequest.userMessage)
      : null
    if (!materialized) assert.fail('the section-two writer was never dispatched')
    assert.ok(
      materialized.claims.length > 0 && materialized.sources.length === 0,
      'the fixture did not produce a claims-with-no-sources dossier',
    )
    assert.match(toolText(result), /Pipeline complete/u)
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'completed')
    assert.match(
      readDraft(assignmentPath, 'section-two'),
      /states the limitation/u,
    )
  })
})

test('a claims-with-no-sources dossier tells its writer to cite no URL at all', async () => {
  // The validator's relaxation is only half the contract. The instructions the
  // request carries are what a live writer actually obeys, so a dossier that
  // holds no URL must not be handed the evidence-bearing citation rule: a
  // writer told to put a canonical source URL beside each claim answers a
  // sourceless dossier with an invented one, a refusal, or nothing at all.
  await withSectionRun(async (assignmentPath) => {
    writeSourcelessSectionDossier(assignmentPath, 'section-two')
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-sourceless-contract',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: dossier.claims.map((claim) => claim.claimId),
          sourceIds: [],
          markdown:
            '## Retention\n\nThe evidence records an open uncertainty and no ' +
            'observed source, so this section states the limitation rather ' +
            'than a measured result.',
        })
      },
    )

    await runDraftSectionsStage(assignmentPath, provider)

    const sectionRequest = requests.find(
      (request) => readSectionIdFromRequest(request.userMessage) === 'section-two',
    )
    if (!sectionRequest) assert.fail('the section-two writer was never dispatched')
    const materialized = readMaterializedDossier(sectionRequest.userMessage)
    if (!materialized) assert.fail('the section-two request carried no dossier')
    assert.ok(
      materialized.claims.length > 0 && materialized.sources.length === 0,
      'the fixture did not produce a claims-with-no-sources dossier',
    )
    assert.doesNotMatch(
      sectionRequest.userMessage,
      /canonical URL of a supporting source/u,
      'a dossier holding no source URL was still told to cite one',
    )
    // The rule the writer is given is the rule the runtime enforces: the check
    // reads http(s) URLs only, and a bare authority like `vendor.example.com`
    // is not separable from ordinary prose, so it is not claimed as forbidden.
    assert.match(
      sectionRequest.userMessage,
      /Do not write an http or https URL/u,
      'a sourceless dossier was not told to leave links out of its prose',
    )
    assert.match(
      sectionRequest.userMessage,
      /empty sourceIds/u,
      'a sourceless dossier was not told to return an empty sourceIds array',
    )
    // The skeleton is the part a writer copies. A placeholder for evidence the
    // dossier cannot supply is an instruction to invent an identifier, which
    // the runtime then rejects as unknown.
    assert.match(
      sectionRequest.userMessage,
      /"claimIds":\["<claim ids/u,
      'the skeleton dropped the claim id placeholder this dossier can fill',
    )
    assert.match(
      sectionRequest.userMessage,
      /"sourceIds":\[\]/u,
      'the skeleton showed a source id placeholder this dossier cannot fill',
    )
  })
})

test('a sourceless dossier draft that invents a URL in its prose is rejected', async () => {
  // Nothing downstream re-checks a persisted draft's citations —
  // `readSectionDrafts` in the synthesis bundle reads the file and trusts it —
  // so this is the last gate. A section whose evidence observed no source has
  // no URL any statement can rest on, and a fabricated one must not reach the
  // synthesizer as a completed draft.
  await withSectionRun(async (assignmentPath) => {
    writeSourcelessSectionDossier(assignmentPath, 'section-two')
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-invented-citation',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: dossier.claims.map((claim) => claim.claimId),
          sourceIds: [],
          markdown:
            '## Retention\n\nRetention held at 92% across the period ' +
            '(https://invented.example.com/retention-report).\n',
        })
      },
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-two')),
      false,
      'a draft citing a URL this section never observed was persisted',
    )
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'failed')
    assert.match(toolText(result), /https:\/\/invented\.example\.com/u)
  })
})

test('an evidence-empty dossier draft that invents a URL in its prose is rejected', async () => {
  // The no-URL rule covers both sourceless shapes. A dossier holding neither
  // claims nor sources observed nothing at all, so a URL in its prose is as
  // invented there as in a section whose claims carry no source — and this
  // section is the one most tempted to fabricate, because it has nothing else
  // to write. Returning such a draft unchecked is what an early return for the
  // evidence-empty shape would do.
  await withSectionRun(async (assignmentPath) => {
    writeEvidenceEmptySectionDossier(assignmentPath, 'section-two')
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-empty-invented-citation',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: [],
          sourceIds: [],
          markdown:
            '## Retention\n\nRetention held at 92% across the period ' +
            '(https://invented.example.com/retention-report).\n',
        })
      },
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    const sectionRequest = requests.find(
      (request) => readSectionIdFromRequest(request.userMessage) === 'section-two',
    )
    const materialized = sectionRequest
      ? readMaterializedDossier(sectionRequest.userMessage)
      : null
    if (!materialized) assert.fail('the section-two writer was never dispatched')
    assert.ok(
      materialized.claims.length === 0 && materialized.sources.length === 0,
      'the fixture did not produce an evidence-empty dossier',
    )
    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-two')),
      false,
      'a draft citing a URL this section never observed was persisted',
    )
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'failed')
    assert.match(toolText(result), /https:\/\/invented\.example\.com/u)
  })
})

test('a draft omitting the source identifiers of an evidence-bearing dossier is rejected', async () => {
  // The other half of the same guard: a dossier that does carry sources must
  // be answered with their identifiers, and the omission must be named as one
  // rather than left to the prose-URL check further down.
  await withSectionRun(async (assignmentPath) => {
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-omitted-sources',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: dossier.claims.map((claim) => claim.claimId),
          sourceIds: [],
          markdown:
            `## ${dossier.sectionId}\n\nSupported (${dossier.sources[0]?.canonicalUrl}).\n`,
        })
      },
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    const sectionRequest = requests.find(
      (request) => readSectionIdFromRequest(request.userMessage) === 'section-two',
    )
    const materialized = sectionRequest
      ? readMaterializedDossier(sectionRequest.userMessage)
      : null
    if (!materialized) assert.fail('the section-two writer was never dispatched')
    assert.ok(
      materialized.sources.length > 0,
      'the fixture did not produce an evidence-bearing dossier',
    )
    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-two')),
      false,
      "a draft omitting this section's source identifiers was persisted",
    )
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'failed')
    assert.match(toolText(result), /omits claim or source identifiers/u)
  })
})

test('a draft omitting the claim identifiers of an evidence-bearing dossier is rejected', async () => {
  // The relaxation above is scoped to what the dossier actually holds. A
  // section that does carry claims must still say which ones it rests on.
  await withSectionRun(async (assignmentPath) => {
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-omitted-claims',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: [],
          sourceIds: dossier.sources.map((source) => source.sourceId),
          markdown:
            `## ${dossier.sectionId}\n\nSupported (${dossier.sources[0]?.canonicalUrl}).\n`,
        })
      },
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    const sectionRequest = requests.find(
      (request) => readSectionIdFromRequest(request.userMessage) === 'section-two',
    )
    const materialized = sectionRequest
      ? readMaterializedDossier(sectionRequest.userMessage)
      : null
    if (!materialized) assert.fail('the section-two writer was never dispatched')
    assert.ok(
      materialized.sources.length > 0,
      'the fixture did not produce an evidence-bearing dossier',
    )
    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-two')),
      false,
      "a draft omitting this section's claim identifiers was persisted",
    )
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'failed')
    assert.match(toolText(result), /omits claim or source identifiers/u)
  })
})

test('section dossiers do not receive unresolved questions from another section', async () => {
  await withSectionRun(async (assignmentPath) => {
    const plan = readApprovedPlan(assignmentPath)
    for (const section of plan.sections) {
      const dossier: unknown = JSON.parse(fs.readFileSync(
        path.join(
          assignmentPath,
          'research',
          'sections',
          section.id,
          'dossier-current.json',
        ),
        'utf8',
      ))
      if (!isRecord(dossier)) assert.fail('the section dossier is not an object')
      assert.deepEqual(dossier.unresolvedQuestions, [
        `Open question owned by ${section.id}.`,
      ])
    }
  }, (packet, task) => ({
    ...packet,
    unresolvedQuestions: [`Open question owned by ${task.sectionId}.`],
  }))
})

test('a section draft citing an unknown claim identifier is rejected', async () => {
  await withSectionRun(async (assignmentPath) => {
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-unknown-claim',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: ['claim-from-another-section'],
          sourceIds: dossier.sources.map((source) => source.sourceId),
          markdown: `## ${dossier.sectionId}\n\nSupported (${dossier.sources[0]?.canonicalUrl}).\n`,
        })
      },
    )

    await runDraftSectionsStage(assignmentPath, provider)

    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-two')),
      false,
      'a draft citing an unknown claim was persisted',
    )
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'failed')
  })
})

test('a section draft citing an unknown source identifier is rejected', async () => {
  await withSectionRun(async (assignmentPath) => {
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'section-writer-unknown-source',
      requests,
      (options) => {
        const dossier = readMaterializedDossier(options.userMessage)
        if (!dossier) return 'no dossier'
        if (dossier.sectionId !== 'section-two') {
          return answerSectionFromRequest(options.userMessage)
        }
        return JSON.stringify({
          schemaVersion: 1,
          status: 'section_complete',
          sectionId: dossier.sectionId,
          claimIds: dossier.claims.map((claim) => claim.claimId),
          sourceIds: ['source-never-observed'],
          markdown: `## ${dossier.sectionId}\n\nSupported (https://invented.example.net/x).\n`,
        })
      },
    )

    await runDraftSectionsStage(assignmentPath, provider)

    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-two')),
      false,
      'a draft citing an unknown source was persisted',
    )
    assert.equal(sectionTaskStatus(assignmentPath, 'section-two'), 'failed')
  })
})

test('section drafting is refused when the section index does not belong to the approved plan', async () => {
  // A run keeps `current-*.json` pointers that a loopback or a reused
  // assignment directory can leave behind. Drafting from whichever index
  // happens to exist would hand a writer another plan's evidence — valid
  // JSON, wrong report.
  await withSectionRun(async (assignmentPath) => {
    const indexPath = path.join(
      assignmentPath, 'research', 'sections', 'current-index.json',
    )
    const index: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    if (!index || typeof index !== 'object') assert.fail('the section index is not an object')
    writeJson(indexPath, { ...index, planId: 'plan-from-another-run' })

    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'writer-foreign-index',
      requests,
      (options) => answerSectionFromRequest(options.userMessage),
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    assert.equal(
      requests.length,
      0,
      'a section index from another plan reached a section writer',
    )
    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-one')),
      false,
      'a draft was persisted from another plan\'s evidence',
    )
    assert.match(toolText(result), /plan-from-another-run|does not belong/u)
  })
})

test('a drafting task whose result path no section owns is refused before dispatch', async () => {
  // In a configured drafting stage every task is a section draft. A task the
  // index does not claim used to fall through to the generic persistence path,
  // where an unvalidated response became a completed artifact.
  await withSectionRun(async (assignmentPath) => {
    const sectionPlanPath = path.join(
      assignmentPath, 'research', 'section-plan.md',
    )
    fs.appendFileSync(
      sectionPlanPath,
      [
        '',
        '#### T3: Unindexed extra',
        '- **Agent:** research-section-writer',
        '- **Status:** pending',
        '- **Validate:** false',
        '- **Depends on:** none',
        '- **Gate:** false',
        '- **Result file:** research/sections/section-three/draft-wave-0.md',
        '',
      ].join('\n'),
    )

    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'writer-unindexed-task',
      requests,
      (options) => answerSectionFromRequest(options.userMessage),
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    assert.equal(
      fs.existsSync(draftPath(assignmentPath, 'section-three')),
      false,
      'an unvalidated response was persisted for a task no section owns',
    )
    assert.equal(sectionTaskStatus(assignmentPath, 'section-three'), 'failed')
    assert.match(toolText(result), /section-three|no section/u)
  })
})

test('a section index claiming one draft path twice is refused', async () => {
  await withSectionRun(async (assignmentPath) => {
    const indexPath = path.join(
      assignmentPath, 'research', 'sections', 'current-index.json',
    )
    const index: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    if (!index || typeof index !== 'object' || !('dossiers' in index)) {
      assert.fail('the section index has no dossier list')
    }
    const dossiers = index.dossiers
    if (!Array.isArray(dossiers) || dossiers.length < 2) {
      assert.fail('the section index fixture needs two dossiers')
    }
    const [first, second] = dossiers
    writeJson(indexPath, {
      ...index,
      dossiers: [first, { ...second, draftPath: first.draftPath }],
    })

    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'writer-duplicate-draft-path',
      requests,
      (options) => answerSectionFromRequest(options.userMessage),
    )

    const result = await runDraftSectionsStage(assignmentPath, provider)

    assert.equal(
      requests.length,
      0,
      'an ambiguous section index reached a section writer',
    )
    assert.match(toolText(result), /more than once/iu)
  })
})

test('a section writer request is refused before launch when its attached input does not fit', async () => {
  // The dossier payload is only part of what the writer receives. The task
  // message, the attached input files, and the agent's own system prompt ride
  // along, so admitting the payload alone lets a large attachment overflow the
  // window with the compaction ladder reporting everything fits.
  await withSectionRun(async (assignmentPath) => {
    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'writer-oversize-attachment',
      requests,
      (options) => answerSectionFromRequest(options.userMessage),
    )

    const result = await runDraftSectionsStage(assignmentPath, provider, {
      inputFilesContent: 'Attached supporting material. '.repeat(25_000),
    })

    assert.equal(
      requests.length,
      0,
      'an over-budget section writer request reached the provider',
    )
    assert.match(toolText(result), /refused before launch/u)
    assert.match(toolText(result), /admissible/u)
  })
})

test('an over-budget synthesis bundle is refused before the synthesizer is dispatched', async () => {
  await withSectionRun(async (assignmentPath) => {
    // 400 KB of validated draft per section. Nothing about it is malformed —
    // it simply cannot fit beside the plan context and evidence index in a
    // 200k-token window that reserves 32k tokens for the report.
    const filler = 'Validated narrative sentence about the evidence. '.repeat(8_500)
    const writerRequests: ProviderExecuteOptions[] = []
    const writerProvider = registerCapturingProvider(
      'section-writer-oversize',
      writerRequests,
      (options) => answerSectionFromRequest(options.userMessage, filler),
    )
    await runDraftSectionsStage(assignmentPath, writerProvider)

    const synthesisRequests: ProviderExecuteOptions[] = []
    const synthesizerProvider = registerCapturingProvider(
      'synthesizer-oversize',
      synthesisRequests,
      () => '# Report\n',
    )

    const result = await runSynthesizeEvidenceStage(
      assignmentPath,
      synthesizerProvider,
    )

    assert.equal(
      synthesisRequests.length,
      0,
      'an over-budget synthesis request reached the provider',
    )
    const text = toolText(result)
    assert.match(text, /refused before launch/u)
    assert.match(text, /admissible/u)
  })
})

test('synthesis refuses instead of dropping the claim index to fit its request budget', async () => {
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-claim-index-floor', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )

    assert.throws(
      () => buildDeepResearchSynthesisBundle({
        assignmentPath,
        planArtifact: 'research/approved-plan.json',
        dossierIndexArtifact: 'research/sections/current-index.json',
        synthesisArtifact: 'research/synthesis/current.json',
        budget: { contextWindowTokens: 2_000, outputReserveTokens: 1_000 },
        renderRequest: (text) => ({ systemPrompt: '', userMessage: text }),
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof ProviderRequestBudgetError,
          `expected a budget refusal, got ${String(error)}`,
        )
        return true
      },
      'the synthesizer was admitted only after its claim index was removed',
    )
  })
})

test('a supplied chain message does not bypass the runtime-owned synthesis bundle', async () => {
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-message-bypass', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )

    const synthesisRequests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'synthesizer-message-bypass',
      synthesisRequests,
      () => '# Report\n',
    )

    await runSynthesizeEvidenceStage(assignmentPath, provider, {
      message: 'Just summarize whatever you already know.',
    })

    assert.equal(synthesisRequests.length, 1)
    const [request] = synthesisRequests
    if (!request) assert.fail('the synthesizer was never dispatched')
    assert.match(
      request.userMessage,
      /Just summarize whatever you already know\./u,
      'the supplied message was dropped instead of accounted as instructions',
    )
    assert.match(
      request.userMessage,
      /Evidence-bound section draft/u,
      'a supplied message replaced the runtime-owned bundle',
    )
    assert.match(
      request.userMessage,
      /Which acquisition channels are economically sustainable\?/u,
      'the bundle carried no approved request context',
    )
  })
})

test('synthesis is refused when an indexed section has no persisted draft', async () => {
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-missing-draft', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )
    fs.rmSync(draftPath(assignmentPath, 'section-two'))

    const synthesisRequests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'synthesizer-missing-draft',
      synthesisRequests,
      () => '# Report\n',
    )

    const result = await runSynthesizeEvidenceStage(assignmentPath, provider)

    assert.equal(
      synthesisRequests.length,
      0,
      'an incomplete run reached the synthesizer',
    )
    assert.match(toolText(result), /section-two/u)
  })
})

test('synthesis is refused when the section index does not belong to the approved plan', async () => {
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-foreign-index', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )
    const indexPath = path.join(
      assignmentPath, 'research', 'sections', 'current-index.json',
    )
    const index: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    if (!index || typeof index !== 'object') assert.fail('the section index is not an object')
    writeJson(indexPath, { ...index, planId: 'plan-from-another-run' })

    const synthesisRequests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'synthesizer-foreign-index',
      synthesisRequests,
      () => '# Report\n',
    )

    const result = await runSynthesizeEvidenceStage(assignmentPath, provider)

    assert.equal(
      synthesisRequests.length,
      0,
      'a section index from another plan reached the synthesizer',
    )
    assert.match(toolText(result), /plan-from-another-run|does not belong/u)
  })
})

test('the synthesis bundle is admitted against the request the caller will really send', async () => {
  // A chain step sends its input twice: substituted into the agent's system
  // prompt, and again inside the step's user message. Counting the bundle once
  // understates that request by half, which is how a "fits comfortably" bundle
  // still overflowed the window.
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-accounting', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )

    const bundleRequest = {
      assignmentPath,
      planArtifact: 'research/approved-plan.json',
      dossierIndexArtifact: 'research/sections/current-index.json',
      synthesisArtifact: 'research/synthesis/current.json',
    }
    const singleCopy = buildDeepResearchSynthesisBundle({
      ...bundleRequest,
      budget: { contextWindowTokens: 200_000, outputReserveTokens: 32_000 },
      renderRequest: (text) => ({ systemPrompt: '', userMessage: text }),
    })

    // A window that admits one copy of this bundle and nothing more.
    const tightBudget = {
      contextWindowTokens: singleCopy.estimatedInputTokens + 10,
      outputReserveTokens: 5,
    }

    assert.ok(
      buildDeepResearchSynthesisBundle({
        ...bundleRequest,
        budget: tightBudget,
        renderRequest: (text) => ({ systemPrompt: '', userMessage: text }),
      }).estimatedInputTokens > 0,
      'one copy of the bundle should still be admitted at this budget',
    )

    assert.throws(
      () => buildDeepResearchSynthesisBundle({
        ...bundleRequest,
        budget: tightBudget,
        renderRequest: (text) => ({ systemPrompt: text, userMessage: text }),
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof ProviderRequestBudgetError,
          `expected a budget refusal, got ${String(error)}`,
        )
        assert.equal(error.stage, 'Deep Research report synthesis')
        assert.ok(
          error.accounting.systemPromptTokens > 0,
          'the refusal did not count the system prompt copy of the bundle',
        )
        return true
      },
      'a request carrying the bundle twice was admitted against a one-copy budget',
    )
  })
})

test('a synthesis correction wave carries its requested changes and the prior report', async () => {
  // A REVISE verdict routed to synthesis archives the previous report, deletes
  // the live one, and leaves a correction context pointing at the immutable
  // verdict. The synthesizer used to open those files itself; with no
  // filesystem it would otherwise be asked to revise a report it cannot see
  // against blockers it never learns.
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-correction', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )
    writeCorrectionWave(assignmentPath)

    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'synthesizer-correction-wave',
      requests,
      () => '# Report\n\nRevised.\n',
    )

    await runSynthesizeEvidenceStage(assignmentPath, provider)

    assert.equal(requests.length, 1)
    const [request] = requests
    if (!request) assert.fail('the synthesizer was never dispatched')
    assert.match(
      request.userMessage,
      /Separate the payback figures by segment/u,
      'the bundle carried none of the requested corrections',
    )
    assert.match(
      request.userMessage,
      /Prior report under revision/u,
      'the bundle carried no prior report to revise',
    )
    assert.match(
      request.userMessage,
      /The previous acquisition narrative/u,
      'the prior report body was not carried',
    )
  })
})

test('a research-route correction wave still synthesizes from refreshed evidence', async () => {
  // Both wave scripts write `research/corrections/current.json`. After a
  // research-routed correction returns through evidence collection and
  // drafting, that file holds `new_research` requests and no resynthesis
  // criteria — the synthesizer must build the report from the refreshed
  // evidence, not refuse for want of instructions it was never given.
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-research-route', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )
    writeCorrectionWave(assignmentPath, { route: 'research' })

    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'synthesizer-research-route',
      requests,
      () => '# Report\n\nRebuilt from refreshed evidence.\n',
    )

    const result = await runSynthesizeEvidenceStage(assignmentPath, provider)

    assert.equal(
      requests.length,
      1,
      'a research-route correction wave blocked synthesis',
    )
    const [request] = requests
    if (!request) assert.fail('the synthesizer was never dispatched')
    assert.match(request.userMessage, /Evidence-bound section draft/u)
    assert.doesNotMatch(
      request.userMessage,
      /Requested corrections/u,
      'a research-route wave was presented as a report revision',
    )
    assert.match(toolText(result), /complete/iu)
  })
})

test('a correction context that does not match its source verdict is refused', async () => {
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-tampered-context', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )
    writeCorrectionWave(assignmentPath, { tamperVerdictHash: true })

    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'synthesizer-tampered-context',
      requests,
      () => '# Report\n',
    )

    const result = await runSynthesizeEvidenceStage(assignmentPath, provider)

    assert.equal(
      requests.length,
      0,
      'a correction context bound to a different verdict reached the synthesizer',
    )
    assert.match(toolText(result), /verdict/iu)
  })
})

test('a correction context naming a missing source verdict is refused', async () => {
  await withSectionRun(async (assignmentPath) => {
    await runDraftSectionsStage(
      assignmentPath,
      registerCapturingProvider('writer-for-missing-verdict', [], (options) =>
        answerSectionFromRequest(options.userMessage)),
    )
    writeCorrectionWave(assignmentPath, { omitSourceVerdict: true })

    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'synthesizer-missing-verdict',
      requests,
      () => '# Report\n',
    )

    const result = await runSynthesizeEvidenceStage(assignmentPath, provider)

    assert.equal(
      requests.length,
      0,
      'a correction context with no source verdict reached the synthesizer',
    )
    assert.match(toolText(result), /does not exist/iu)
  })
})

test('a single-pass run still synthesizes from the runtime-owned bundle', async () => {
  // The section-dossier repair must not cost smaller reports their path. A
  // single-pass plan writes a dossier index with no draft paths, so its bundle
  // is the approved request and the evidence index and nothing else.
  const assignmentPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-single-pass-')),
  )
  try {
    prepareFinalizedSectionRun(assignmentPath, SINGLE_PASS_POLICY)

    const requests: ProviderExecuteOptions[] = []
    const provider = registerCapturingProvider(
      'synthesizer-single-pass',
      requests,
      () => '# Report\n\nSynthesized in one pass.\n',
    )

    const result = await runSynthesizeEvidenceStage(assignmentPath, provider)

    assert.match(toolText(result), /complete/iu)
    assert.equal(requests.length, 1)
    const [request] = requests
    if (!request) assert.fail('the synthesizer was never dispatched')
    assert.match(request.userMessage, /Evidence index/u)
    assert.match(
      request.userMessage,
      /Which acquisition channels are economically sustainable\?/u,
    )
    assert.doesNotMatch(
      request.userMessage,
      /Evidence-bound section draft/u,
      'a single-pass bundle carried section drafts it never produced',
    )
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
})

// ─── Journey helpers ─────────────────────────────────────────────────────────

interface MaterializedClaim {
  readonly claimId: string
  readonly sourceIds: readonly string[]
}

interface MaterializedSource {
  readonly sourceId: string
  readonly canonicalUrl: string
}

interface MaterializedDossier {
  readonly sectionId: string
  readonly claims: readonly MaterializedClaim[]
  readonly sources: readonly MaterializedSource[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readMaterializedClaim(value: unknown): MaterializedClaim | null {
  if (!isRecord(value) || typeof value.claimId !== 'string') return null
  const sourceIds = Array.isArray(value.sourceIds)
    ? value.sourceIds.filter((id): id is string => typeof id === 'string')
    : []
  return { claimId: value.claimId, sourceIds }
}

function readMaterializedSource(value: unknown): MaterializedSource | null {
  if (
    !isRecord(value) ||
    typeof value.sourceId !== 'string' ||
    typeof value.canonicalUrl !== 'string'
  ) {
    return null
  }
  return { sourceId: value.sourceId, canonicalUrl: value.canonicalUrl }
}

/**
 * The dossier the runtime put in the request, or null when it put only a path
 * there. Deliberately strict: the fake writer must not be able to guess an
 * answer the request never contained.
 */
function readMaterializedDossier(userMessage: string): MaterializedDossier | null {
  const fence = /```json\s*([\s\S]*?)```/u.exec(userMessage)
  const body = fence?.[1]
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.sectionId !== 'string') return null
  if (!Array.isArray(parsed.claims) || !Array.isArray(parsed.sources)) return null
  const claims = parsed.claims.map(readMaterializedClaim)
  const sources = parsed.sources.map(readMaterializedSource)
  if (claims.some((claim) => claim === null)) return null
  if (sources.some((source) => source === null)) return null
  return {
    sectionId: parsed.sectionId,
    claims: claims.filter((claim): claim is MaterializedClaim => claim !== null),
    sources: sources.filter((source): source is MaterializedSource => source !== null),
  }
}

function readSectionIdFromRequest(userMessage: string): string | null {
  return readMaterializedDossier(userMessage)?.sectionId ?? null
}

/** Draft a section using only what the request materialized. */
function answerSectionFromRequest(userMessage: string, filler = ''): string {
  const dossier = readMaterializedDossier(userMessage)
  if (!dossier) {
    return JSON.stringify({
      schemaVersion: 1,
      status: 'input_unavailable',
      note:
        'I cannot read the dossier file referenced in this assignment. ' +
        'Please provide its contents.',
    })
  }
  const citations = dossier.sources
    .map((source) => `(${source.canonicalUrl})`)
    .join(' ')
  return JSON.stringify({
    schemaVersion: 1,
    status: 'section_complete',
    sectionId: dossier.sectionId,
    claimIds: dossier.claims.map((claim) => claim.claimId),
    sourceIds: dossier.sources.map((source) => source.sourceId),
    markdown:
      `## ${dossier.sectionId}\n\n` +
      `The validated evidence supports the section objective. ${citations}\n` +
      (filler ? `\n${filler}\n` : ''),
  })
}

let providerSequence = 0

function registerCapturingProvider(
  label: string,
  captured: ProviderExecuteOptions[],
  answer: (options: ProviderExecuteOptions) => string,
): string {
  providerSequence += 1
  const name = `deep-research-${label}-${providerSequence}`
  registerProvider({
    name,
    execute: async (options) => {
      captured.push(options)
      return providerResult(answer(options))
    },
  })
  return name
}

function draftPath(assignmentPath: string, sectionId: string): string {
  return path.join(
    assignmentPath,
    'research',
    'sections',
    sectionId,
    'draft-wave-0.md',
  )
}

/**
 * Rewrite one section's dossier into the evidence-empty shape a correction
 * wave leaves behind when no usable source survives it.
 */
function writeEvidenceEmptySectionDossier(
  assignmentPath: string,
  sectionId: string,
): void {
  for (const dossierPath of sectionDossierPaths(assignmentPath, sectionId)) {
    const dossier: unknown = JSON.parse(fs.readFileSync(dossierPath, 'utf8'))
    if (!isRecord(dossier)) assert.fail('the section dossier is not an object')
    writeJson(dossierPath, {
      ...dossier,
      claims: [],
      sources: [],
      contradictions: [],
      unresolvedQuestions: ['No usable source survived the correction boundary.'],
    })
  }
}

/** The wave file and the current pointer a drafting task can resolve. */
function sectionDossierPaths(
  assignmentPath: string,
  sectionId: string,
): readonly string[] {
  return ['dossier-wave-0.json', 'dossier-current.json'].map((basename) =>
    path.join(assignmentPath, 'research', 'sections', sectionId, basename),
  )
}

/**
 * Rewrite one section's dossier into the claims-with-no-sources shape.
 *
 * An `uncertainty` finding carries no evidence link and no source id, and the
 * dossier derives its sources from the union of the claim source ids, so the
 * section arrives at its writer holding claims and no URL at all.
 */
function writeSourcelessSectionDossier(
  assignmentPath: string,
  sectionId: string,
): void {
  for (const dossierPath of sectionDossierPaths(assignmentPath, sectionId)) {
    const dossier: unknown = JSON.parse(fs.readFileSync(dossierPath, 'utf8'))
    if (!isRecord(dossier)) assert.fail('the section dossier is not an object')
    const [claim] = Array.isArray(dossier.claims) ? dossier.claims : []
    if (!isRecord(claim)) assert.fail('the section dossier fixture has no claim')
    writeJson(dossierPath, {
      ...dossier,
      claims: [{
        ...claim,
        kind: 'uncertainty',
        status: 'unsupported',
        evidenceStandard: 'single',
        confidence: 'low',
        sourceIds: [],
        evidenceLinks: [],
      }],
      sources: [],
      coverage: [],
      contradictions: [],
    })
  }
}

function readDraft(assignmentPath: string, sectionId: string): string {
  return fs.readFileSync(draftPath(assignmentPath, sectionId), 'utf8')
}

/**
 * The executable-plan status of the task that owns one section's draft.
 *
 * The runtime copies the run-owned section plan into its private pipeline
 * directory and drives that copy; the source file keeps its authored statuses.
 */
function sectionTaskStatus(
  assignmentPath: string,
  sectionId: string,
): string | null {
  const plan = parsePlan(
    path.join(assignmentPath, '.runtime', 'pipeline', 'draft-sections', 'plan.md'),
  )
  if (!plan) return null
  const relativeDraft = `research/sections/${sectionId}/draft-wave-0.md`
  const owner = [...plan.tasks.values()].find(
    (task: PlanTask) => task.resultFile === relativeDraft,
  )
  return owner?.status ?? null
}

async function withSectionRun(
  run: (assignmentPath: string) => Promise<void>,
  transformEvidencePacket?: (
    packet: EvidencePacket,
    task: ResearchTask,
  ) => EvidencePacket,
): Promise<void> {
  const assignmentPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-section-runtime-')),
  )
  try {
    prepareFinalizedSectionRun(
      assignmentPath,
      SECTION_POLICY,
      transformEvidencePacket,
    )
    await run(assignmentPath)
  } finally {
    fs.rmSync(assignmentPath, { recursive: true, force: true })
  }
}

async function runDraftSectionsStage(
  assignmentPath: string,
  providerName: string,
  options: { readonly inputFilesContent?: string } = {},
): Promise<unknown> {
  const teamConfig = parseRequiredTeamConfig(
    path.join(RESEARCH_TEAM_ROOT, 'team.yaml'),
  )
  const level = teamConfig.levels.find(
    (candidate) => candidate.id === 'draft-sections',
  )
  if (!level) assert.fail('the research team has no draft-sections level')
  const rosterEntry = teamConfig.agents.find(
    (candidate) => candidate.name === 'research-section-writer',
  )
  if (!rosterEntry) assert.fail('the research team has no research-section-writer')
  return createPipelineTool({
    teamName: 'research-team',
    teamConfig,
    teamRootPath: RESEARCH_TEAM_ROOT,
    levelId: 'draft-sections',
    config: level.stage,
    agents: new Map([
      ['research-section-writer', {
        name: 'research-section-writer',
        systemPrompt: 'FIXTURE_ROLE:research-section-writer\n\n{{TASK_CONTENT}}',
        agentDir: assignmentPath,
        experienceEnabled: false,
        model: 'fixture-model',
        thinking: 'low',
        tools: [],
        provider: providerName,
      }],
    ]),
    rosterEntries: new Map([['research-section-writer', rosterEntry]]),
    state: runtimeState('draft-sections'),
    workspacePath: assignmentPath,
    outputPath: assignmentPath,
    inputFilesContent: options.inputFilesContent ?? '',
    agentMetrics: new Map(),
    stageFailureOverride: 'halt',
  } as never).execute(
    'draft-section-dossiers',
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  )
}

async function runSynthesizeEvidenceStage(
  assignmentPath: string,
  providerName: string,
  params: { readonly message?: string } = {},
): Promise<unknown> {
  const teamConfig = parseRequiredTeamConfig(
    path.join(RESEARCH_TEAM_ROOT, 'team.yaml'),
  )
  const level = teamConfig.levels.find(
    (candidate) => candidate.id === 'synthesize-evidence',
  )
  if (!level) assert.fail('the research team has no synthesize-evidence level')
  const rosterEntry = teamConfig.agents.find(
    (candidate) => candidate.name === 'research-synthesizer',
  )
  if (!rosterEntry) assert.fail('the research team has no research-synthesizer')
  return createChainTool({
    teamName: 'research-team',
    teamConfig,
    teamRootPath: RESEARCH_TEAM_ROOT,
    levelId: 'synthesize-evidence',
    config: level.stage,
    agents: new Map([
      ['research-synthesizer', {
        name: 'research-synthesizer',
        systemPrompt: 'FIXTURE_ROLE:research-synthesizer\n\n{{TASK_CONTENT}}',
        agentDir: assignmentPath,
        experienceEnabled: false,
        model: 'fixture-model',
        thinking: 'low',
        tools: [],
        provider: providerName,
      }],
    ]),
    rosterEntries: new Map([['research-synthesizer', rosterEntry]]),
    state: runtimeState('synthesize-evidence'),
    workspacePath: assignmentPath,
    outputPath: assignmentPath,
    inputFilesContent: '',
    agentMetrics: new Map(),
    stageFailureOverride: 'halt',
    getCurrentCoordinatorRunId: () => 1,
    coordinatorName: 'research-synthesizer',
  } as never).execute(
    'synthesize-evidence-bundle',
    params as never,
    undefined as never,
    undefined as never,
    undefined as never,
  )
}

// ─── Fixture construction ────────────────────────────────────────────────────

/**
 * Write an approved two-section plan plus its evidence, then run the real
 * evidence-wave finalizer so the dossiers, index, and section plan on disk are
 * the ones production writes.
 */
function prepareFinalizedSectionRun(
  assignmentPath: string,
  policy: ResearchExecutionPolicy = SECTION_POLICY,
  transformEvidencePacket?: (
    packet: EvidencePacket,
    task: ResearchTask,
  ) => EvidencePacket,
): ResearchPlan {
  const plan = approveResearchPlan(makeTwoSectionPlan(policy), TEST_TIME)
  writeJson(path.join(assignmentPath, 'research', 'approved-plan.json'), plan)

  const evidenceByTask = new Map<string, string>()
  for (const task of plan.tasks) {
    const relativePath = `research/evidence/wave-0/${task.id}.json`
    evidenceByTask.set(task.id, relativePath)
    writeJson(
      path.join(assignmentPath, relativePath),
      transformEvidencePacket
        ? transformEvidencePacket(makeSectionEvidencePacket(plan, task), task)
        : makeSectionEvidencePacket(plan, task),
    )
  }

  finalizeDeepResearchEvidenceWave({
    assignmentPath,
    planArtifact: 'research/approved-plan.json',
    executablePlan: makeExecutablePlan(plan, evidenceByTask),
  })
  writeRuntimeLimits(assignmentPath, plan)
  return plan
}

/** The runtime-owned budget contract every Deep Research stage reads. */
function writeRuntimeLimits(assignmentPath: string, plan: ResearchPlan): void {
  const startedAt = new Date()
  writeJson(path.join(assignmentPath, 'research', 'runtime-limits.json'), {
    schemaVersion: 1,
    planId: plan.planId,
    maxDurationMinutes: plan.maxDurationMinutes,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(
      startedAt.getTime() + plan.maxDurationMinutes * 60_000,
    ).toISOString(),
  })
}

function makeTwoSectionPlan(
  policy: ResearchExecutionPolicy = SECTION_POLICY,
): ResearchPlan {
  const firstSpec = makeWorkerSpec()
  const secondSpec = makeWorkerSpec({
    id: 'worker-two',
    laneId: 'lane-two',
    sectionId: 'section-two',
    displayRole: 'Retention Economics Analyst',
    question: 'Which retention programs hold their measured payback?',
  })
  const tasks: ResearchTask[] = [
    {
      schemaVersion: 1,
      id: 'task-one',
      sectionId: 'section-one',
      title: 'Channel economics',
      question: firstSpec.question,
      purpose: 'evidence_acquisition',
      workerSpecId: firstSpec.id,
      dependsOn: [],
      correctionWave: 0,
    },
    {
      schemaVersion: 1,
      id: 'task-two',
      sectionId: 'section-two',
      title: 'Retention economics',
      question: secondSpec.question,
      purpose: 'evidence_acquisition',
      workerSpecId: secondSpec.id,
      dependsOn: [],
      correctionWave: 0,
    },
  ]
  const sections: ResearchSection[] = [
    {
      schemaVersion: 1,
      id: 'section-one',
      title: 'Acquisition',
      objective: 'Compare acquisition economics.',
      taskIds: ['task-one'],
    },
    {
      schemaVersion: 1,
      id: 'section-two',
      title: 'Retention',
      objective: 'Compare retention economics.',
      taskIds: ['task-two'],
    },
  ]
  return makePlan({
    sections,
    tasks,
    workerSpecs: [firstSpec, secondSpec],
    expectedPeakWorkers: 2,
    executionPolicy: policy,
  })
}

function makeSectionEvidencePacket(
  plan: ResearchPlan,
  task: ResearchTask,
): EvidencePacket {
  const workerSpec = plan.workerSpecs.find(
    (candidate) => candidate.id === task.workerSpecId,
  )
  if (!workerSpec) assert.fail(`task '${task.id}' has no worker specification`)
  const suffix = task.id.replace('task-', '')
  const sources: SourceRecord[] = [
    makeSource({
      assignmentId: workerSpec.laneId,
      sourceId: `source-${suffix}-primary`,
      canonicalUrl: `https://example.com/${suffix}-report`,
      publisher: `Example Research ${suffix}`,
      independenceKey: `example-research-${suffix}`,
      contentSha256: 'c'.repeat(64),
    }),
    makeSource({
      assignmentId: workerSpec.laneId,
      sourceId: `source-${suffix}-independent`,
      canonicalUrl: `https://independent.example.org/${suffix}-benchmark`,
      publisher: `Independent Benchmark ${suffix}`,
      independenceKey: `independent-benchmark-${suffix}`,
      sourceType: 'industry',
      contentSha256: 'd'.repeat(64),
    }),
  ]
  const claimId = `claim-${suffix}`
  const sourceIds = sources.map((source) => source.sourceId)
  const findings = [{
    schemaVersion: 1 as const,
    claimId,
    taskId: task.id,
    sectionId: task.sectionId,
    statement: `${task.title} holds up under independent corroboration.`,
    kind: 'fact' as const,
    evidenceStandard: 'independent_corroboration' as const,
    sourceIds,
    evidenceLinks: sources.map((source) => ({
      sourceId: source.sourceId,
      observationReceiptId: requiredReceiptId(source),
      observedExcerpt: `Observed evidence from ${source.publisher}.`,
      locator: `Source ${source.sourceId}`,
      relationship: 'supports' as const,
    })),
    confidence: 'high' as const,
    status: 'supported' as const,
    applicableScope: ['B2B SaaS'],
  }]
  return makeEvidencePacket({
    assignmentId: workerSpec.laneId,
    taskId: task.id,
    workerSpecHash: hashResearchValue(workerSpec),
    question: task.question,
    findings,
    sources,
    coverage: [
      {
        schemaVersion: 2 as const,
        requirementId: 'cac',
        status: 'satisfied' as const,
        claimIds: [claimId],
        sourceIds,
        value: '$120',
        unit: 'USD per acquired customer',
        asOf: TEST_TIME,
        scope: ['B2B SaaS'],
      },
      {
        schemaVersion: 2 as const,
        requirementId: 'payback-period',
        status: 'satisfied' as const,
        claimIds: [claimId],
        sourceIds,
        value: '9',
        unit: 'months',
        asOf: TEST_TIME,
        scope: ['B2B SaaS'],
      },
    ],
  })
}

/** Every usable acquired source carries a receipt; a test fixture that lost one is broken. */
function requiredReceiptId(source: SourceRecord): string {
  if (!source.observationReceiptId) {
    assert.fail(`fixture source '${source.sourceId}' has no observation receipt`)
  }
  return source.observationReceiptId
}

function makeExecutablePlan(
  plan: ResearchPlan,
  evidenceByTask: ReadonlyMap<string, string>,
): PlanState {
  return {
    title: 'Approved research',
    status: 'executing',
    sprints: [{
      id: 'S1',
      name: 'Evidence',
      taskIds: plan.tasks.map((task) => task.id),
      gateTaskId: null,
    }],
    tasks: new Map(plan.tasks.map((task) => {
      const resultFile = evidenceByTask.get(task.id)
      if (!resultFile) assert.fail(`task '${task.id}' has no evidence artifact`)
      return [task.id, {
        id: task.id,
        title: task.title,
        agent: 'web-researcher',
        status: 'completed' as const,
        validate: false,
        dependsOn: [],
        gate: false,
        resultFile,
        sprintId: 'S1',
      }]
    })),
  }
}

// ─── Shared harness helpers ──────────────────────────────────────────────────

/**
 * The artifacts a REVISE verdict leaves behind, on either route.
 *
 * `research/corrections/current.json` is written by both wave scripts —
 * `prepare-resynthesis-wave.mjs` and `prepare-correction-wave.mjs` — so the
 * same configured artifact carries a synthesis-routed verdict on one loopback
 * and a research-routed one on the other.
 */
function writeCorrectionWave(
  assignmentPath: string,
  options: {
    readonly route?: 'synthesis' | 'research'
    readonly tamperVerdictHash?: boolean
    readonly omitSourceVerdict?: boolean
  } = {},
): void {
  const route = options.route ?? 'synthesis'
  const sourceVerdictPath = 'research/quality/verdict-wave-0.json'
  const verdict = {
    schemaVersion: 1 as const,
    verdictId: 'verdict-wave-0',
    correctionWave: 0 as const,
    decision: 'REVISE' as const,
    correctionRoute: route,
    findings: [],
    correctionRequests: [
      route === 'synthesis'
        ? {
            schemaVersion: 1 as const,
            id: 'resynthesis-one',
            type: 'resynthesize' as const,
            claimIds: [],
            taskIds: [],
            sectionIds: ['section-one'],
            acceptanceCriteria: ['Separate the payback figures by segment.'],
            impactScope: 'global' as const,
          }
        : {
            schemaVersion: 1 as const,
            id: 'research-one',
            type: 'new_research' as const,
            claimIds: [],
            taskIds: ['task-one'],
            sectionIds: ['section-one'],
            acceptanceCriteria: ['Find a second independent payback benchmark.'],
            impactScope: 'local' as const,
          },
    ],
    reviewedAt: TEST_TIME,
  }
  if (!options.omitSourceVerdict) {
    writeJson(path.join(assignmentPath, sourceVerdictPath), verdict)
  }
  fs.mkdirSync(path.join(assignmentPath, 'research', 'reports'), { recursive: true })
  fs.writeFileSync(
    path.join(assignmentPath, 'research', 'reports', 'report-wave-0.md'),
    '# Research package\n\nThe previous acquisition narrative.\n',
  )
  const plan = readApprovedPlan(assignmentPath)
  writeJson(path.join(assignmentPath, 'research', 'corrections', 'current.json'), {
    schemaVersion: 1,
    wave: 1,
    approvedPlanHash: plan.approvalHash,
    sourceVerdictPath,
    sourceVerdictHash: options.tamperVerdictHash
      ? 'f'.repeat(64)
      : hashResearchValue(verdict),
    taskRequests: route === 'research' ? { 'task-one': [verdict.correctionRequests[0]] } : {},
  })
}

function readApprovedPlan(assignmentPath: string): ResearchPlan {
  const raw: unknown = JSON.parse(
    fs.readFileSync(
      path.join(assignmentPath, 'research', 'approved-plan.json'),
      'utf8',
    ),
  )
  return assertResearchPlanApproved(raw)
}

function parseRequiredTeamConfig(teamPath: string) {
  const parsed = parseTeamConfig(teamPath)
  assert.deepEqual(parsed.errors, [])
  if (!parsed.config) assert.fail(`team config did not parse: ${teamPath}`)
  return parsed.config
}

function runtimeState(levelId: string) {
  return {
    sessionId: 'assignment-one',
    currentLevelIndex: 0,
    levelStates: new Map([
      [levelId, {
        status: 'active',
        stageStatus: STAGE_LIFECYCLE_STATUS.READY,
        loopbackCount: 0,
        engineState: null,
      }],
    ]),
    totalCost: 0,
    startTime: Date.now(),
    timerStarted: true,
    endTime: null,
    spawnDepth: 0,
    rootSessionId: 'run-one',
    parentSessionId: 'session-one',
  }
}

function providerResult(text: string): ProviderResult {
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

function toolText(result: unknown): string {
  return (
    result as { content?: Array<{ text?: string }> }
  ).content?.[0]?.text ?? ''
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
