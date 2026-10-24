/**
 * Turn-boundary validation and materialization for `resource_updates` plans.
 *
 * The model proposes operations without revisions. This module decides whether
 * the user actually authorized each target, whether the requested additions are
 * possible, and stamps the revision the server calculated itself.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  ChatTurn,
  ResourceUpdateOperationDraft,
  ResourceUpdatePlanDraft,
} from '../../contracts/resource-architect.js'
import {
  computeAgentRevision,
  computeTeamRevision,
} from '../../domains/resource-architect/resource-revision.js'
import {
  materializeResourceUpdatePlan,
  ResourceUpdatePlanError,
} from '../../domains/resource-architect/resource-update-plan.js'

const TEAM_ID = 'contract-review-team'
const SECOND_TEAM_ID = 'diligence-team'
const ROSTER_AGENT = 'michigan-contract-lawyer'
const LIBRARY_AGENT = 'scoping-lawyer'
const NEW_AGENT = 'drafting-completeness-lawyer'

function persona(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} description.\ntier: strategic\n---\n\n# ${name}\n`
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'update-plan-'))
  for (const name of [ROSTER_AGENT, LIBRARY_AGENT]) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, `${name}.md`), persona(name))
  }
  const registry: string[] = []
  for (const teamId of [TEAM_ID, SECOND_TEAM_ID]) {
    const teamDir = path.join(repoRoot, 'teams', teamId)
    fs.mkdirSync(teamDir, { recursive: true })
    fs.writeFileSync(
      path.join(teamDir, 'team.yaml'),
      [
        'team:',
        `  name: "${teamId}"`,
        'agents:',
        `  - name: "${ROSTER_AGENT}"`,
        '    type: agent',
        '    role: >',
        '      Michigan contract reviewer',
        '    tier: strategic',
        '    tools: []',
        `    agent_file: "../../agents/${ROSTER_AGENT}/${ROSTER_AGENT}.md"`,
        'levels: []',
        '',
      ].join('\n'),
    )
    registry.push(
      `${teamId}:`,
      '  type: team',
      '  description: Reviews contracts.',
      `  team_path: ./teams/${teamId}`,
      '  tags: []',
    )
  }
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), `${registry.join('\n')}\n`)
  return repoRoot
}

function makeAddOperation(
  overrides: Partial<Extract<ResourceUpdateOperationDraft, { kind: 'add_team_agents' }>> = {},
): ResourceUpdateOperationDraft {
  return {
    kind: 'add_team_agents',
    target: { kind: 'team', id: TEAM_ID },
    libraryAgentsToAdd: [
      { name: LIBRARY_AGENT, role: 'Scope reviewer', rationale: 'Reuse.' },
    ],
    newAgentsToCreate: [
      {
        name: NEW_AGENT,
        role: 'Drafting reviewer',
        description: 'Checks drafting completeness.',
        rationale: 'No existing Agent covers drafting gaps.',
      },
    ],
    ...overrides,
  }
}

function makeDraft(
  operations: ResourceUpdateOperationDraft[] = [makeAddOperation()],
): ResourceUpdatePlanDraft {
  return { id: 'proposal-1', kind: 'resource_updates', operations }
}

function requestHistory(text = `Add ${LIBRARY_AGENT} and ${NEW_AGENT} to ${TEAM_ID}.`): ChatTurn[] {
  return [{ role: 'user', text }]
}

function withRepo(run: (repoRoot: string) => void): void {
  const repoRoot = makeRepo()
  try {
    run(repoRoot)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

test('materialization stamps the revision the server calculated, not one the model chose', () => {
  withRepo((repoRoot) => {
    const draft = makeDraft()
    // An untrusted revision on the wire must be discarded rather than trusted.
    Object.assign(draft.operations[0]!, { expectedRevision: 'sha256:deadbeef' })

    const plan = materializeResourceUpdatePlan({
      repoRoot,
      draft,
      history: requestHistory(),
    })

    assert.equal(plan.kind, 'resource_updates')
    assert.equal(plan.id, 'proposal-1')
    assert.equal(plan.operations.length, 1)
    assert.equal(
      plan.operations[0]?.expectedRevision,
      computeTeamRevision(repoRoot, TEAM_ID),
    )
  })
})

test('a target the user never named carries no mutation authority', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft(),
          history: [{ role: 'user', text: 'Add a drafting reviewer somewhere useful.' }],
        }),
      new RegExp(TEAM_ID),
    )
  })
})

test('an assistant mention of the Team does not authorize an update', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft(),
          history: [
            { role: 'user', text: 'Add a drafting reviewer.' },
            { role: 'assistant', text: `I could extend ${TEAM_ID}.` },
          ],
        }),
      new RegExp(TEAM_ID),
    )
  })
})

test('an unknown Team target is rejected', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            makeAddOperation({ target: { kind: 'team', id: 'no-such-team' } }),
          ]),
          history: requestHistory('Add scoping-lawyer to no-such-team.'),
        }),
      /no-such-team/,
    )
  })
})

test('an update plan must contain at least one operation', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([]),
          history: requestHistory(),
        }),
      /at least one operation/i,
    )
  })
})

test('an add_team_agents operation must add at least one Agent', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            makeAddOperation({ libraryAgentsToAdd: [], newAgentsToCreate: [] }),
          ]),
          history: requestHistory(),
        }),
      /at least one Agent/i,
    )
  })
})

test('a library addition that is not in the Agent library is rejected', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            makeAddOperation({
              libraryAgentsToAdd: [
                { name: 'absent-lawyer', role: 'r', rationale: 'x' },
              ],
              newAgentsToCreate: [],
            }),
          ]),
          history: requestHistory(`Add absent-lawyer to ${TEAM_ID}.`),
        }),
      /absent-lawyer/,
    )
  })
})

test('a library addition already on the roster is rejected', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            makeAddOperation({
              libraryAgentsToAdd: [
                { name: ROSTER_AGENT, role: 'r', rationale: 'x' },
              ],
              newAgentsToCreate: [],
            }),
          ]),
          history: requestHistory(`Add ${ROSTER_AGENT} to ${TEAM_ID}.`),
        }),
      new RegExp(ROSTER_AGENT),
    )
  })
})

test('a new Agent whose name already exists is rejected', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            makeAddOperation({
              libraryAgentsToAdd: [],
              newAgentsToCreate: [
                {
                  name: LIBRARY_AGENT,
                  role: 'r',
                  description: 'd',
                  rationale: 'x',
                },
              ],
            }),
          ]),
          history: requestHistory(`Add ${LIBRARY_AGENT} to ${TEAM_ID}.`),
        }),
      new RegExp(LIBRARY_AGENT),
    )
  })
})

test('a name repeated across both addition lists is rejected', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            makeAddOperation({
              libraryAgentsToAdd: [
                { name: LIBRARY_AGENT, role: 'r', rationale: 'x' },
              ],
              newAgentsToCreate: [
                {
                  name: LIBRARY_AGENT,
                  role: 'r',
                  description: 'd',
                  rationale: 'x',
                },
              ],
            }),
          ]),
          history: requestHistory(),
        }),
      /duplicate/i,
    )
  })
})

test('a new Agent name that breaks the repository naming rule is rejected', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            makeAddOperation({
              libraryAgentsToAdd: [],
              newAgentsToCreate: [
                {
                  name: 'Drafting Lawyer',
                  role: 'r',
                  description: 'd',
                  rationale: 'x',
                },
              ],
            }),
          ]),
          history: requestHistory(`Add Drafting Lawyer to ${TEAM_ID}.`),
        }),
      /kebab-case/i,
    )
  })
})

test('an Agent skill update is stamped with the revision read from that package', () => {
  withRepo((repoRoot) => {
    const plan = materializeResourceUpdatePlan({
      repoRoot,
      draft: makeDraft([
        {
          kind: 'update_agent_skills',
          target: { kind: 'agent', id: LIBRARY_AGENT },
          skillUpdates: [
            { action: 'create', name: 'scope-review', instruction: 'Review scope.' },
          ],
        },
      ]),
      history: requestHistory(`Give ${LIBRARY_AGENT} a scope-review skill.`),
    })

    const operation = plan.operations[0]
    assert.ok(operation)
    assert.equal(operation.kind, 'update_agent_skills')
    // Calculated from the package on disk, never from anything the model sent.
    assert.equal(operation.expectedRevision, computeAgentRevision(repoRoot, LIBRARY_AGENT))
  })
})

test('an Agent with no package on disk cannot be the target of a skill update', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            {
              kind: 'update_agent_skills',
              target: { kind: 'agent', id: 'nobody-wrote-this-agent' },
              skillUpdates: [
                { action: 'create', name: 'scope-review', instruction: 'Review scope.' },
              ],
            },
          ]),
          history: requestHistory('Give nobody-wrote-this-agent a scope-review skill.'),
        }),
      /Agent not found: nobody-wrote-this-agent/,
    )
  })
})

test('an Agent id that points outside agents/ is not an Agent', () => {
  withRepo((repoRoot) => {
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            {
              kind: 'update_agent_skills',
              target: { kind: 'agent', id: '../teams/contract-review-team' },
              skillUpdates: [
                { action: 'create', name: 'scope-review', instruction: 'Review scope.' },
              ],
            },
          ]),
          history: requestHistory('Give ../teams/contract-review-team a scope-review skill.'),
        }),
      ResourceUpdatePlanError,
    )
  })
})

test('a plan may not update the same Team twice', () => {
  withRepo((repoRoot) => {
    // Both operations would be stamped with the same revision, and each is
    // authorized against a Team the other one is about to change. Whichever
    // ran second would conflict against its sibling's write, so the pair is
    // refused before either is materialized.
    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([
            makeAddOperation({ newAgentsToCreate: [] }),
            makeAddOperation({
              libraryAgentsToAdd: [],
              newAgentsToCreate: [
                {
                  name: NEW_AGENT,
                  role: 'Drafting reviewer',
                  description: 'Checks drafting completeness.',
                  rationale: 'No existing Agent covers drafting gaps.',
                },
              ],
            }),
          ]),
          history: requestHistory(),
        }),
      (error: unknown) =>
        error instanceof ResourceUpdatePlanError &&
        error.code === 'bad_request' &&
        /only once/u.test(error.message) &&
        error.message.includes(TEAM_ID),
    )
  })
})

test('a plan may not create the same Agent name for two Teams', () => {
  withRepo((repoRoot) => {
    // One Agent name is one Agent. Two operations creating it would reserve and
    // generate a single global identity twice and race for the same folder.
    const createNewAgent = (teamId: string): ResourceUpdateOperationDraft => ({
      kind: 'add_team_agents',
      target: { kind: 'team', id: teamId },
      libraryAgentsToAdd: [],
      newAgentsToCreate: [
        {
          name: NEW_AGENT,
          role: 'Drafting reviewer',
          description: 'Checks drafting completeness.',
          rationale: 'No existing Agent covers drafting gaps.',
        },
      ],
    })

    assert.throws(
      () =>
        materializeResourceUpdatePlan({
          repoRoot,
          draft: makeDraft([createNewAgent(TEAM_ID), createNewAgent(SECOND_TEAM_ID)]),
          history: requestHistory(
            `Add ${NEW_AGENT} to ${TEAM_ID} and to ${SECOND_TEAM_ID}.`,
          ),
        }),
      (error: unknown) =>
        error instanceof ResourceUpdatePlanError &&
        error.code === 'bad_request' &&
        /only once/u.test(error.message) &&
        error.message.includes(NEW_AGENT),
    )
  })
})

test('one library Agent may join two different Teams in one plan', () => {
  withRepo((repoRoot) => {
    // An Agent that already exists is one identity being referenced twice, not
    // created twice, so this stays a legitimate request.
    const addLibraryAgent = (teamId: string): ResourceUpdateOperationDraft => ({
      kind: 'add_team_agents',
      target: { kind: 'team', id: teamId },
      libraryAgentsToAdd: [
        { name: LIBRARY_AGENT, role: 'Scope reviewer', rationale: 'Reuse.' },
      ],
      newAgentsToCreate: [],
    })

    const plan = materializeResourceUpdatePlan({
      repoRoot,
      draft: makeDraft([addLibraryAgent(TEAM_ID), addLibraryAgent(SECOND_TEAM_ID)]),
      history: requestHistory(
        `Add ${LIBRARY_AGENT} to ${TEAM_ID} and to ${SECOND_TEAM_ID}.`,
      ),
    })

    assert.deepEqual(
      plan.operations.map((operation) => operation.target.id),
      [TEAM_ID, SECOND_TEAM_ID],
    )
    for (const operation of plan.operations) {
      assert.equal(operation.kind, 'add_team_agents')
      if (operation.kind !== 'add_team_agents') continue
      assert.deepEqual(
        operation.libraryAgentsToAdd.map((agent) => agent.name),
        [LIBRARY_AGENT],
      )
      assert.equal(operation.expectedRevision, computeTeamRevision(repoRoot, operation.target.id))
    }
  })
})

/**
 * A registered Team this repository cannot read is a conflict, not a bad
 * request.
 *
 * The Team registry names the target and its folder is there, so the user's
 * proposal is not what is wrong. The builder's own projection reads YAML
 * forgivingly and would hand back an empty, valid-looking Team, which is worse
 * than an error: the update would be authorized against a roster that is not
 * the Team's. The named target's `team.yaml` is therefore required to be a
 * readable regular file before that projection is trusted.
 */
test('a registered Team whose team.yaml cannot be read is a conflict', () => {
  withRepo((repoRoot) => {
    const teamYamlPath = path.join(repoRoot, 'teams', TEAM_ID, 'team.yaml')
    fs.rmSync(teamYamlPath, { force: true })
    // Registered, its folder present, and its file is not a file.
    fs.mkdirSync(teamYamlPath, { recursive: true })

    try {
      materializeResourceUpdatePlan({
        repoRoot,
        draft: makeDraft(),
        history: requestHistory(),
      })
      assert.fail('expected the unreadable Team to be reported')
    } catch (error) {
      assert.ok(
        error instanceof ResourceUpdatePlanError,
        `unexpected error: ${String(error)}`,
      )
      assert.equal(error.code, 'conflict')
      assert.match(error.message, new RegExp(TEAM_ID))
    }
  })
})

/**
 * `teams.yaml` is what says a Team exists.
 *
 * Asking the builder's projection instead makes existence depend on a
 * `team.yaml` being there, so a Team the registry plainly names comes back as
 * one nobody created — and the user is told to fix a proposal that named a
 * real Team. The registry is the register; a target it names whose file is
 * gone is a repository this server cannot act on, not a bad request.
 */
test('a Team the registry names whose team.yaml is missing is a conflict', () => {
  withRepo((repoRoot) => {
    fs.rmSync(path.join(repoRoot, 'teams', TEAM_ID, 'team.yaml'), { force: true })

    try {
      materializeResourceUpdatePlan({
        repoRoot,
        draft: makeDraft(),
        history: requestHistory(),
      })
      assert.fail('expected the missing team.yaml to be reported')
    } catch (error) {
      assert.ok(
        error instanceof ResourceUpdatePlanError,
        `unexpected error: ${String(error)}`,
      )
      assert.equal(error.code, 'conflict')
      assert.match(error.message, new RegExp(TEAM_ID))
    }
  })
})

/** A Team no registry entry names is still simply not there. */
test('a Team the registry does not name is still a bad request', () => {
  withRepo((repoRoot) => {
    try {
      materializeResourceUpdatePlan({
        repoRoot,
        draft: makeDraft([makeAddOperation({ target: { kind: 'team', id: 'nobody-registered-this' } })]),
        history: requestHistory('Add scoping-lawyer to nobody-registered-this.'),
      })
      assert.fail('expected the unknown Team to be reported')
    } catch (error) {
      assert.ok(error instanceof ResourceUpdatePlanError)
      assert.equal(error.code, 'bad_request')
      assert.match(error.message, /Team not found: nobody-registered-this/)
    }
  })
})

/** Rewrites `teams.yaml` with exactly the entries given. */
function writeRegistry(
  repoRoot: string,
  entries: ReadonlyArray<{ id: string; teamPath?: string }>,
): void {
  const lines: string[] = []
  for (const entry of entries) {
    lines.push(
      `${entry.id}:`,
      '  type: team',
      '  description: Reviews contracts.',
      ...(entry.teamPath === undefined ? [] : [`  team_path: ${entry.teamPath}`]),
      '  tags: []',
    )
  }
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), `${lines.join('\n')}\n`)
}

function expectPlanError(repoRoot: string, teamId = TEAM_ID): ResourceUpdatePlanError {
  try {
    materializeResourceUpdatePlan({
      repoRoot,
      draft: makeDraft([makeAddOperation({ target: { kind: 'team', id: teamId } })]),
      history: requestHistory(`Add ${LIBRARY_AGENT} and ${NEW_AGENT} to ${teamId}.`),
    })
  } catch (error) {
    assert.ok(
      error instanceof ResourceUpdatePlanError,
      `unexpected error: ${String(error)}`,
    )
    return error
  }
  return assert.fail('expected the repository fault to be reported')
}

/**
 * A registry this server cannot read says nothing about the user's proposal.
 *
 * With no entries to find, every named Team looks unregistered, and the answer
 * would be "Team not found" about a Team that may well be there.
 */
test('a Team registry that cannot be read is a conflict, not a bad request', () => {
  withRepo((repoRoot) => {
    const registryPath = path.join(repoRoot, 'teams.yaml')
    fs.rmSync(registryPath, { force: true })
    fs.mkdirSync(registryPath, { recursive: true })

    const error = expectPlanError(repoRoot)

    assert.equal(error.code, 'conflict')
    assert.match(error.message, /registry/i)
  })
})

/**
 * An entry the registry rejected is not an entry that is absent.
 *
 * `teams.yaml` names this Team and the parser refused its entry, so the
 * repository is inconsistent about a Team the user correctly named.
 */
test('a registry entry rejected for the named Team is a conflict', () => {
  withRepo((repoRoot) => {
    writeRegistry(repoRoot, [{ id: TEAM_ID }])

    const error = expectPlanError(repoRoot)

    assert.equal(error.code, 'conflict')
    assert.match(error.message, new RegExp(TEAM_ID))
  })
})

/** Somebody else's broken entry is not this proposal's problem. */
test('an unrelated malformed registry entry does not block a valid named Team', () => {
  withRepo((repoRoot) => {
    writeRegistry(repoRoot, [
      { id: TEAM_ID, teamPath: `./teams/${TEAM_ID}` },
      { id: SECOND_TEAM_ID },
    ])

    const plan = materializeResourceUpdatePlan({
      repoRoot,
      draft: makeDraft(),
      history: requestHistory(),
    })

    assert.equal(plan.operations[0]?.target.id, TEAM_ID)
  })
})
