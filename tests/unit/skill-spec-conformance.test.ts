/**
 * Guards the Agent Skills specification (https://agentskills.io/specification)
 * for every `SKILL.md` in the repository, for the skills the agent generator
 * writes, and for the publication gate that refuses a non-conformant skill.
 *
 * The rules themselves live in
 * `domains/agent-generator/skill-spec-validation.ts`, which the production
 * commit path also calls, so this suite and publication cannot drift apart.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectRepositorySkillDirectories } from '../../scripts/collect-repository-skills.js'

import { commitAgent, runCreateAgent } from '../../domains/agent-generator/index.js'
import { createFallbackSkill } from '../../domains/agent-generator/planned-agent-builder.js'
import {
  findSkillSpecViolations,
  type SkillSpecViolation,
} from '../../domains/agent-generator/skill-spec-validation.js'

/**
 * Walks up from this test file to the directory holding `package.json`. The
 * suite runs from `.tests-dist/`, so a fixed number of `..` segments would
 * resolve to the build output rather than the repository.
 */
function findRepoRoot(startDir: string): string {
  let current = startDir
  for (let depth = 0; depth < 10; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`Could not locate the repository root from ${startDir}`)
}

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))

test('every SKILL.md in the repository satisfies the Agent Skills specification', () => {
  const skillDirs = collectRepositorySkillDirectories(repoRoot)
  assert.ok(skillDirs.length > 0, 'expected to find at least one SKILL.md')

  const violations: SkillSpecViolation[] = []
  for (const skillDir of skillDirs) {
    const skillPath = path.join(skillDir, 'SKILL.md')
    violations.push(
      ...findSkillSpecViolations({
        source: fs.readFileSync(skillPath, 'utf8'),
        folderName: path.basename(skillDir),
        skillPath: path.relative(repoRoot, skillPath),
      }),
    )
  }

  assert.deepEqual(
    violations.map((violation) => `${violation.skillPath}: ${violation.problem}`),
    [],
  )
})

test('the offline agent generator writes a specification-conformant skill', async () => {
  const generatorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-spec-'))
  fs.mkdirSync(path.join(generatorRoot, 'teams', 'workflow-architect'), { recursive: true })
  fs.mkdirSync(path.join(generatorRoot, 'agents', 'workflow-architect'), { recursive: true })
  fs.writeFileSync(
    path.join(generatorRoot, 'teams', 'workflow-architect', 'team.yaml'),
    [
      'agents:',
      '  - name: workflow-architect',
      '    role: Architect',
      '    agent_file: ../../agents/workflow-architect/workflow-architect.md',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(generatorRoot, 'agents', 'workflow-architect', 'workflow-architect.md'),
    // The architect runs with its own agent file's pair.
    "---\nmodel: test-model\nprovider: openai\n---\n\n" + ('Return an agent draft as JSON.'),
  )
  fs.writeFileSync(path.join(generatorRoot, 'teams.yaml'), '')

  const previousOpenAiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    const result = await runCreateAgent({
      repoRoot: generatorRoot,
      skillPaths: [],
      chatHistory: [
        { role: 'user', text: 'Create an expert in value proposition validation.' },
      ],
    })

    assert.equal('duplicate' in result, false)
    if ('duplicate' in result) return
    assert.equal('needsInput' in result, false)
    if ('needsInput' in result) return

    const generated = result.generatedSkills ?? []
    assert.equal(generated.length, 1)
    const skill = generated[0]
    assert.ok(skill)

    assert.deepEqual(
      findSkillSpecViolations({
        source: skill.body,
        folderName: skill.name,
        skillPath: `generated:${skill.name}`,
      }).map((violation) => violation.problem),
      [],
    )

    const description = skill.body.match(/^description:\s*(.*)$/m)?.[1] ?? ''
    assert.match(
      description,
      /use when/i,
      'a generated skill description must state when to use the skill, not only what it does',
    )
  } finally {
    fs.rmSync(generatorRoot, { recursive: true, force: true })
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAiKey
  }
})

test('commitAgent refuses to publish a generated skill that breaks the specification', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gate-'))
  try {
    await assert.rejects(
      commitAgent({
        repoRoot,
        approvedName: 'drafting-completeness-lawyer',
        personaMarkdown: '---\nname: drafting-completeness-lawyer\n---\n\n# Draft\n',
        skillPaths: [],
        generatedSkills: [
          {
            name: 'drafting-review',
            // The frontmatter name does not match the folder name, and the
            // description is missing entirely.
            body: '---\nname: something-else\n---\n\n# Draft review\n',
          },
        ],
      }),
      /drafting-review/,
    )
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'agents', 'drafting-completeness-lawyer')),
      false,
      'a rejected skill must leave no partially published Agent package',
    )
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('the planned-Agent fallback skill says what it does and when to use it', () => {
  // This skill is published whenever a planned Agent draft comes back with no
  // skills of its own. The structural validator deliberately checks shape
  // rather than prose, so nothing else stops a description that never tells an
  // agent when to activate the skill.
  const skill = createFallbackSkill({
    name: 'drafting-completeness-lawyer',
    role: 'Drafting reviewer',
    description: 'Checks drafting completeness.',
    rationale: 'No existing Agent covers drafting gaps.',
  })

  assert.deepEqual(
    findSkillSpecViolations({
      source: skill.body,
      folderName: skill.name,
      skillPath: `generated:${skill.name}`,
    }).map((violation) => violation.problem),
    [],
  )
  const description = skill.body.match(/^description:\s*(.*)$/m)?.[1] ?? ''
  assert.match(
    description,
    /use when/i,
    'a fallback skill description must state when to use the skill, not only what it is for',
  )
})
