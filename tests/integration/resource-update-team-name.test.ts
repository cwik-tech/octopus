import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChatTurn } from '../../contracts/resource-architect.js'
import { ResourceUpdateTargetConfirmationRequired } from '../../domains/resource-architect/resource-update-policy.js'
import { materializeResourceUpdatePlan } from '../../domains/resource-architect/resource-update-plan.js'

function makeBoardRepo(competingTeam = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-team-name-'))
  const board = path.join(root, 'teams/software-architecture-board')
  fs.mkdirSync(board, { recursive: true })
  fs.writeFileSync(path.join(board, 'team.yaml'), 'team:\n  name: software-architecture-board\nagents: []\nlevels: []\n')
  fs.writeFileSync(path.join(root, 'teams.yaml'), [
    'software-architecture-board:',
    '  type: team',
    '  description: Architecture advisers.',
    '  team_path: ./teams/software-architecture-board',
    ...(competingTeam ? [
      'software-architecture-team:',
      '  type: team',
      '  description: A different Team whose file need not be read.',
      '  team_path: ./teams/software-architecture-team',
    ] : []),
    '',
  ].join('\n'))
  return root
}

function makeRequest(): ChatTurn {
  return { role: 'user', text: 'Create the advisers and add them to the software architecture team.' }
}
const question = 'Did you mean Team `software-architecture-board`? Reply yes to confirm, or give the exact Team ID you meant.'

function propose(root: string, history: ChatTurn[] = [makeRequest()]) {
  return materializeResourceUpdatePlan({
    repoRoot: root,
    draft: {
      id: 'architecture-proposal', kind: 'resource_updates',
      operations: [{
        kind: 'add_team_agents', target: { kind: 'team', id: 'software-architecture-board' },
        libraryAgentsToAdd: [],
        newAgentsToCreate: [{
          name: 'architect-software-design', role: 'Software design adviser',
          description: 'Assess module boundaries and cross-language patterns.',
          rationale: 'Requested addition.',
        }],
      }],
    },
    history,
  })
}

test('confirming the exact Board ID prepares its update without writing the roster or Agents', () => {
  const root = makeBoardRepo(true)
  try {
    const teamFile = path.join(root, 'teams/software-architecture-board/team.yaml')
    const original = fs.readFileSync(teamFile, 'utf8')

    assert.throws(() => propose(root), (error: unknown) =>
      error instanceof ResourceUpdateTargetConfirmationRequired && error.question === question)
    const proposal = propose(root, [
      makeRequest(), { role: 'assistant', text: question }, { role: 'user', text: 'yes' },
    ])

    assert.equal(proposal.operations[0]?.target.id, 'software-architecture-board')
    assert.match(proposal.operations[0]?.expectedRevision ?? '', /^sha256:[a-f0-9]{64}$/u)
    assert.equal(fs.readFileSync(teamFile, 'utf8'), original)
    assert.equal(fs.existsSync(path.join(root, 'agents/architect-software-design')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unconfirmed Board asks for its exact ID even when it is the only registered Team', () => {
  const root = makeBoardRepo()
  try {
    assert.throws(() => propose(root), (error: unknown) =>
      error instanceof ResourceUpdateTargetConfirmationRequired && error.question === question)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
