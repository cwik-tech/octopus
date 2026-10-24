/**
 * One authorized update is one Team write.
 *
 * `addTeamBuilderAgents` appends every requested roster entry and, when the
 * entry level runs an explicit discussion, the same names as participants —
 * under a single mutation lock, against a revision the caller pinned earlier.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addTeamBuilderAgents,
  digestTeamYaml,
  removeTeamBuilderAgent,
} from '../../domains/agent-generator/team-manager.js'
import { computeTeamRevision } from '../../domains/resource-architect/resource-revision.js'

const TEAM_ID = 'contract-review-team'
const SEEDED = 'michigan-contract-lawyer'
const REMOVABLE = 'existing-reviewer'
const CUSTOM_MARKER = 'CUSTOM-ESCALATION-CONTRACT'

function persona(name: string, marker = ''): string {
  return `---\nname: ${name}\ndescription: ${name} description.\ntier: strategic\n${marker}---\n\n# ${name}\n`
}

function makeRepo(options: {
  discussionEntry: boolean
  existingMember?: boolean
}): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-batch-'))
  for (const name of [
    SEEDED,
    REMOVABLE,
    'scoping-lawyer',
    'drafting-completeness-lawyer',
  ]) {
    const agentDir = path.join(repoRoot, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, `${name}.md`), persona(name))
  }
  const frontDoorDir = path.join(repoRoot, 'agents', 'general-agent')
  fs.mkdirSync(frontDoorDir, { recursive: true })
  fs.writeFileSync(
    path.join(frontDoorDir, 'general-agent.md'),
    persona('general-agent', 'system: true\n'),
  )
  const teamDir = path.join(repoRoot, 'teams', TEAM_ID)
  fs.mkdirSync(teamDir, { recursive: true })
  const levels = options.discussionEntry
    ? [
        'levels:',
        '  - id: review',
        '    name: Review',
        '    order: 0',
        '    stage:',
        '      type: discussion',
        `      coordinator: "${SEEDED}"`,
        '      participants:',
        `        - "${SEEDED}"`,
        ...(options.existingMember ? [`        - "${REMOVABLE}"`] : []),
        '      config:',
        '        mode: brainstorm',
      ]
    : [
        'levels:',
        '  - id: review',
        '    name: Review',
        '    order: 0',
        '    stage:',
        '      type: chain',
        '      sequence:',
        `        - "${SEEDED}"`,
        '      config:',
        '        handoff_format: markdown',
      ]
  fs.writeFileSync(
    path.join(teamDir, 'team.yaml'),
    [
      'team:',
      `  name: "${TEAM_ID}"`,
      '  description: >',
      '    Reviews contracts.',
      'workflow:',
      '  entry_level: review',
      'agents:',
      `  - name: "${SEEDED}"`,
      '    type: agent',
      '    role: >',
      '      Michigan contract reviewer',
      '    tier: strategic',
      '    tools: []',
      `    agent_file: "../../agents/${SEEDED}/${SEEDED}.md"`,
      '    experience_enabled: true',
      '    produces:',
      `      - path: "${CUSTOM_MARKER}.md"`,
      ...(options.existingMember
        ? [
            `  - name: "${REMOVABLE}"`,
            '    type: agent',
            '    role: Existing reviewer',
            '    tier: strategic',
            '    tools: []',
            `    agent_file: "../../agents/${REMOVABLE}/${REMOVABLE}.md"`,
            '    experience_enabled: true',
          ]
        : []),
      ...levels,
      'gates:',
      '  - from: review',
      '    to: done',
      '    condition:',
      '      type: artifact_exists',
      `      artifact: "${CUSTOM_MARKER}.md"`,
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    [
      `${TEAM_ID}:`,
      '  type: team',
      '  description: Reviews contracts.',
      `  team_path: ./teams/${TEAM_ID}`,
      '  tags: []',
      '',
    ].join('\n'),
  )
  return repoRoot
}

function rosterNames(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1]!)
}

function participantNames(yaml: string): string[] {
  const lines = yaml.split('\n')
  const keyIndex = lines.findIndex((line) => /^\s*participants:\s*$/.test(line))
  if (keyIndex < 0) return []
  const keyIndent = lines[keyIndex]!.match(/^\s*/)![0].length
  const names: string[] = []
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const entry = lines[index]!.match(/^(\s*)- (.*)$/)
    if (!entry || entry[1]!.length <= keyIndent) break
    names.push(entry[2]!.trim().replace(/"/g, ''))
  }
  return names
}

async function withRepo(
  options: { discussionEntry: boolean; existingMember?: boolean },
  run: (repoRoot: string, teamYamlPath: string) => Promise<void>,
): Promise<void> {
  const repoRoot = makeRepo(options)
  try {
    await run(repoRoot, path.join(repoRoot, 'teams', TEAM_ID, 'team.yaml'))
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

test('a batch addition appends every roster entry and every entry discussion participant', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    const detail = await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
      agents: [
        { name: 'scoping-lawyer', role: 'Scope reviewer' },
        { name: 'drafting-completeness-lawyer', role: 'Drafting reviewer' },
      ],
    })

    const yaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(rosterNames(yaml), [
      SEEDED,
      'scoping-lawyer',
      'drafting-completeness-lawyer',
    ])
    assert.deepEqual(participantNames(yaml), [
      SEEDED,
      'scoping-lawyer',
      'drafting-completeness-lawyer',
    ])
    assert.deepEqual(
      detail.agents.map((agent) => agent.name),
      [SEEDED, 'scoping-lawyer', 'drafting-completeness-lawyer'],
    )
    assert.ok(yaml.includes(CUSTOM_MARKER), 'unrelated YAML must survive')
    assert.ok(yaml.includes('entry_level: review'))
  })
})

test('a batch addition leaves an entry stage without explicit participants alone', async () => {
  await withRepo({ discussionEntry: false }, async (repoRoot, teamYamlPath) => {
    await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
      agents: [{ name: 'scoping-lawyer', role: 'Scope reviewer' }],
    })

    const yaml = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(rosterNames(yaml), [SEEDED, 'scoping-lawyer'])
    assert.equal(participantNames(yaml).length, 0)
    assert.ok(yaml.includes('type: chain'))
  })
})

test('a stale revision fails the batch without touching team.yaml', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      addTeamBuilderAgents({
        repoRoot,
        teamId: TEAM_ID,
        expectedRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        agents: [{ name: 'scoping-lawyer', role: 'Scope reviewer' }],
      }),
      /revision/i,
    )

    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

test('re-applying the same batch adds no duplicate roster entry or participant', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    const revision = computeTeamRevision(repoRoot, TEAM_ID)
    await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: revision,
      agents: [{ name: 'scoping-lawyer', role: 'Scope reviewer' }],
    })
    const afterFirst = fs.readFileSync(teamYamlPath, 'utf8')

    // A retry pins the revision the first write produced, which is what a
    // resumed operation records as its intended final revision.
    await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
      agents: [{ name: 'scoping-lawyer', role: 'Scope reviewer' }],
    })

    const afterSecond = fs.readFileSync(teamYamlPath, 'utf8')
    assert.deepEqual(rosterNames(afterSecond), [SEEDED, 'scoping-lawyer'])
    assert.deepEqual(participantNames(afterSecond), [SEEDED, 'scoping-lawyer'])
    assert.equal(afterSecond, afterFirst)
  })
})

test('a batch addition refuses an Agent with no persona file', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      addTeamBuilderAgents({
        repoRoot,
        teamId: TEAM_ID,
        expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
        agents: [
          { name: 'scoping-lawyer', role: 'Scope reviewer' },
          { name: 'never-generated-lawyer', role: 'Ghost' },
        ],
      }),
      /never-generated-lawyer/,
    )

    assert.equal(
      fs.readFileSync(teamYamlPath, 'utf8'),
      before,
      'a partly valid batch must not half-apply',
    )
  })
})

test('a Team whose roster is not a list is refused before anything is published', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    // The repository parser is deliberately tolerant, so this is a shape the
    // parser accepts and the roster model cannot use. Appending list entries
    // beneath a scalar would produce a Team that no longer describes itself.
    fs.writeFileSync(
      teamYamlPath,
      ['team:', `  name: "${TEAM_ID}"`, 'agents: not-a-list', 'levels: []', ''].join('\n'),
    )
    const before = fs.readFileSync(teamYamlPath, 'utf8')
    const published: string[] = []

    await assert.rejects(
      addTeamBuilderAgents({
        repoRoot,
        teamId: TEAM_ID,
        expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
        agents: [{ name: 'scoping-lawyer', role: 'Scope reviewer' }],
        onRevisionVerified: () => {
          published.push('published')
        },
      }),
      /roster/i,
    )

    assert.deepEqual(
      published,
      [],
      'an unusable Team shape must be found before anything is published',
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

test('an addition with no persona publishes nothing before it fails', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    const before = fs.readFileSync(teamYamlPath, 'utf8')
    const published: string[] = []

    await assert.rejects(
      addTeamBuilderAgents({
        repoRoot,
        teamId: TEAM_ID,
        expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
        agents: [
          { name: 'scoping-lawyer', role: 'Scope reviewer' },
          { name: 'never-generated-lawyer', role: 'Ghost' },
        ],
        onRevisionVerified: () => {
          published.push('published')
        },
      }),
      /never-generated-lawyer/,
    )

    assert.deepEqual(
      published,
      [],
      'every addition is validated before any package is published',
    )
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

test('the recorded intended revision describes the exact bytes written under the lock', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    let reported: string | null = null

    await addTeamBuilderAgents({
      repoRoot,
      teamId: TEAM_ID,
      expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
      agents: [{ name: 'scoping-lawyer', role: 'Scope reviewer' }],
      onIntendedRevision: (revision) => {
        reported = revision
      },
    })

    // Another writer edits the Team the moment the lock is released. A
    // revision recomputed after the fact would describe that edit instead.
    const written = fs.readFileSync(teamYamlPath, 'utf8')
    fs.writeFileSync(teamYamlPath, `${written}# a later, unrelated edit\n`)

    assert.equal(reported, digestTeamYaml(written))
    assert.notEqual(reported, computeTeamRevision(repoRoot, TEAM_ID))
  })
})

test('a removal started while an addition holds the lock keeps both changes', async () => {
  await withRepo(
    { discussionEntry: true, existingMember: true },
    async (repoRoot, teamYamlPath) => {
      // Started from inside the addition's own lock, before it has written
      // anything, so the removal cannot have read the roster the addition is
      // about to produce. It is awaited outside, so a writer that waits for the
      // lock is not waiting on the operation holding it.
      let removal: Promise<unknown> | undefined
      await addTeamBuilderAgents({
        repoRoot,
        teamId: TEAM_ID,
        expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
        agents: [{ name: 'scoping-lawyer', role: 'Scope reviewer' }],
        onIntendedRevision: () => {
          removal = removeTeamBuilderAgent({
            repoRoot,
            teamId: TEAM_ID,
            agentName: REMOVABLE,
          })
        },
      })
      await removal

      // Both writers changed the roster, so both changes have to be there: the
      // removable member is gone and the added one is present. A writer that
      // rewrote the roster from a snapshot taken before the addition would have
      // dropped one of them.
      const yaml = fs.readFileSync(teamYamlPath, 'utf8')
      assert.deepEqual(rosterNames(yaml), [SEEDED, 'scoping-lawyer'])
      assert.deepEqual(participantNames(yaml), [SEEDED, 'scoping-lawyer'])
      assert.ok(
        yaml.includes(CUSTOM_MARKER),
        'unrelated Team content is preserved by both writers',
      )
    },
  )
})

test('a removal leaves the rest of the Team exactly as it was', async () => {
  await withRepo(
    { discussionEntry: true, existingMember: true },
    async (repoRoot, teamYamlPath) => {
      const detail = await removeTeamBuilderAgent({
        repoRoot,
        teamId: TEAM_ID,
        agentName: REMOVABLE,
      })

      assert.deepEqual(detail.agents.map((agent) => agent.name), [SEEDED])
      const yaml = fs.readFileSync(teamYamlPath, 'utf8')
      assert.deepEqual(rosterNames(yaml), [SEEDED])
      assert.ok(yaml.includes(CUSTOM_MARKER), 'the gate contract is untouched')
      assert.deepEqual(participantNames(yaml), [SEEDED])
    },
  )
})

test('removing an Agent that is not on the roster changes nothing', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    const detail = await removeTeamBuilderAgent({
      repoRoot,
      teamId: TEAM_ID,
      agentName: 'scoping-lawyer',
    })

    assert.deepEqual(detail.agents.map((agent) => agent.name), [SEEDED])
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

/**
 * The batch path is a mutation boundary of its own.
 *
 * `resource-architect-service` and `resource-update-executor` call this
 * function directly, so a guard living in `team-builder-service` is not on
 * their way through: the architect could stage a Team whose roster names an
 * agent the runtime owns, and it would reach disk.
 */
test('a system agent is refused by the batch path before anything is published', async () => {
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    const before = fs.readFileSync(teamYamlPath, 'utf8')
    // The caller publishes its staged Agent packages from this hook. A refusal
    // that arrived after it would leave a published Agent beside a Team that
    // never took it.
    let publicationAuthorized = false

    await assert.rejects(
      addTeamBuilderAgents({
        repoRoot,
        teamId: TEAM_ID,
        expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
        agents: [{ name: 'general-agent', role: 'Front door' }],
        onRevisionVerified: () => {
          publicationAuthorized = true
        },
      }),
      /system agent/i,
    )

    assert.equal(publicationAuthorized, false)
    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})

test('a system agent is refused however its name was spelled', async () => {
  // The domain normalizes a supplied name before it resolves the persona, so a
  // check that reads the raw string is looking at something else.
  await withRepo({ discussionEntry: true }, async (repoRoot, teamYamlPath) => {
    const before = fs.readFileSync(teamYamlPath, 'utf8')

    await assert.rejects(
      addTeamBuilderAgents({
        repoRoot,
        teamId: TEAM_ID,
        expectedRevision: computeTeamRevision(repoRoot, TEAM_ID),
        agents: [{ name: 'General Agent', role: 'Front door' }],
      }),
      /system agent/i,
    )

    assert.equal(fs.readFileSync(teamYamlPath, 'utf8'), before)
  })
})
