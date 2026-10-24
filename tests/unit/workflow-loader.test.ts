import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  parseWorkflowRegistry,
  parseWorkflowTemplate,
  parseWorkflowTemplateYaml,
} from '../../workflows/loader.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import {
  validateWorkflowTemplate,
  workflowRequiresHumanInput,
} from '../../workflows/validation.js'
import { BUILTIN_TRANSFORM_EXECUTOR } from '../../workflows/artifact-contracts.js'
import type { TeamRegistryEntry } from '../../core/types.js'

const WRITING_TEAM_PATH = path.join(process.cwd(), 'teams', 'writing-team')
const RESEARCH_TEAM_PATH = path.join(process.cwd(), 'teams', 'research-team')

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-loader-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('parseWorkflowRegistry resolves relative template paths', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'templates', 'discussion.yaml'), 'workflow:\n  id: demo\n  steps: []\n')
    fs.writeFileSync(path.join(dir, 'registry.yaml'), `
discussion-to-writing:
  description: Demo
  template_path: ./templates/discussion.yaml
  tags:
    - discussion
`)

    const result = parseWorkflowRegistry(path.join(dir, 'registry.yaml'))
    assert.equal(result.errors.length, 0)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]?.template_path, path.join(dir, 'templates', 'discussion.yaml'))
  })
})

test('the shipped discussion feedback template is registered and validates', () => {
  const registry = parseWorkflowRegistry(path.join(process.cwd(), 'workflows', 'registry.yaml'))
  assert.deepEqual(registry.errors, [])
  const entry = registry.entries.find((candidate) => candidate.name === 'discussion-feedback-discussion-writing')
  assert.ok(entry)
  const parsed = parseWorkflowTemplate(entry.template_path)
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.template)
  assert.equal(workflowRequiresHumanInput(parsed.template), true)
  const teams = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
  assert.deepEqual(teams.errors, [])
  assert.deepEqual(
    validateWorkflowTemplate(
      parsed.template,
      new Map(teams.entries.map((team) => [team.name, team])),
    ),
    [],
  )
})

test('parseWorkflowTemplate parses sequential team workflow shape', () => {
  withTempDir((dir) => {
    const templatePath = path.join(dir, 'discussion-to-writing.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: discussion-to-writing
  steps:
    - id: discuss
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      handoff:
        from_step: discuss
        from_artifact: output/decomposition-plan.md
        to_artifact: incoming-brief.md
  output:
    from_step: write
    artifact: final-draft.md
`)

    const result = parseWorkflowTemplate(templatePath)
    assert.equal(result.errors.length, 0)
    assert.ok(result.template)
    assert.equal(result.template?.steps.length, 2)
    assert.equal(result.template?.steps[1]?.handoff?.from_step, 'discuss')
    assert.equal(result.template?.steps[0]?.recovery_policy, 'manual')
  })
})

test('parses a human-in-the-loop step and exposes unattended-execution detection', () => {
  const parsed = parseWorkflowTemplateYaml(`
workflow:
  id: discussion-with-feedback
  steps:
    - id: discuss
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/round-1.md
    - id: human-feedback
      type: human-in-the-loop
      prompt: Review the discussion before continuing.
      input_artifact: review/round-1.md
      result_artifact: feedback/round-1.json
      handoff:
        from_step: discuss
        from_artifact: output/round-1.md
        to_artifact: review/round-1.md
    - id: write
      type: team
      team: writing-team
      input_artifact: feedback/round-1.json
      result_artifact: final-draft.md
      handoff:
        from_step: human-feedback
        from_artifact: feedback/round-1.json
        to_artifact: feedback/round-1.json
  output:
    from_step: write
    artifact: final-draft.md
`)

  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.template?.steps[1]?.type, 'human-in-the-loop')
  assert.equal(parsed.template?.steps[1]?.team, undefined)
  assert.equal(workflowRequiresHumanInput(parsed.template!), true)
})

test('loader preserves incompatible human-input fields so validation rejects them', () => {
  const parsed = parseWorkflowTemplateYaml(`
workflow:
  id: incompatible-human-input
  steps:
    - id: discuss
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/round-1.md
    - id: human-feedback
      type: human-in-the-loop
      input_artifact: review/round-1.md
      result_artifact: feedback/round-1.json
      recovery_policy: manual
      mcp_requirements:
        - capability: documents
          access: read
          necessity: required
      handoff:
        from_step: discuss
        from_artifact: output/round-1.md
        to_artifact: review/round-1.md
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      handoff:
        from_step: human-feedback
        from_artifact: feedback/round-1.json
        to_artifact: incoming-brief.md
  output:
    from_step: write
    artifact: final-draft.md
`)

  assert.ok(parsed.template)
  const errors = validateWorkflowTemplate(parsed.template, new Map())
  assert.ok(errors.some((error) => error.includes('must not declare recovery_policy')))
  assert.ok(errors.some((error) => error.includes('must not declare mcp_requirements')))
})

test('validateWorkflowTemplate rejects invalid human-in-the-loop placement', () => {
  const firstStep = validateWorkflowTemplate({
    id: 'human-first',
    steps: [
      {
        id: 'human-feedback',
        type: 'human-in-the-loop',
        input_artifact: 'review.md',
        result_artifact: 'feedback.json',
      },
      {
        id: 'write',
        type: 'team',
        team: 'writing-team',
        input_artifact: 'feedback.json',
        result_artifact: 'final.md',
      },
    ],
    output: { from_step: 'write', artifact: 'final.md' },
  } as any, new Map())
  assert.ok(firstStep.some((error) => error.includes('cannot be the first step')))

  const finalStep = validateWorkflowTemplate({
    id: 'human-final',
    steps: [
      {
        id: 'discuss',
        type: 'team',
        team: 'discussion-team',
        input_artifact: 'incoming.md',
        result_artifact: 'round-1.md',
      },
      {
        id: 'human-feedback',
        type: 'human-in-the-loop',
        input_artifact: 'review.md',
        result_artifact: 'feedback.json',
        handoff: {
          from_step: 'discuss',
          from_artifact: 'round-1.md',
          to_artifact: 'review.md',
        },
      },
    ],
    output: { from_step: 'human-feedback', artifact: 'feedback.json' },
  } as any, new Map())
  assert.ok(finalStep.some((error) => error.includes('cannot be the final step')))

  const transformSuccessor = validateWorkflowTemplate({
    id: 'human-before-transform',
    steps: [
      {
        id: 'discuss',
        type: 'team',
        team: 'discussion-team',
        input_artifact: 'incoming.md',
        result_artifact: 'round-1.md',
      },
      {
        id: 'human-feedback',
        type: 'human-in-the-loop',
        input_artifact: 'review.md',
        result_artifact: 'feedback.json',
        handoff: {
          from_step: 'discuss',
          from_artifact: 'round-1.md',
          to_artifact: 'review.md',
        },
      },
      {
        id: 'publish',
        type: 'transform',
        team: BUILTIN_TRANSFORM_EXECUTOR,
        transform: 'markdown_to_docx',
        input_artifact: 'feedback.json',
        result_artifact: 'final.md',
        handoff: {
          from_step: 'human-feedback',
          from_artifact: 'feedback.json',
          to_artifact: 'feedback.json',
        },
      },
    ],
    output: { from_step: 'publish', artifact: 'final.md' },
  } as any, new Map())
  assert.ok(
    transformSuccessor.some((error) =>
      error.includes("must be followed by a team or agent step"),
    ),
  )
})

test('parseWorkflowTemplate parses step-level brief defaults for packaged writing outputs', () => {
  withTempDir((dir) => {
    const templatePath = path.join(dir, 'discussion-to-summary.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: discussion-to-summary
  steps:
    - id: discuss
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      brief_prefix: |
        Use executive-summary.
      include_initial_brief: true
      brief_suffix: |
        Use strategic-consulting.
      handoff:
        from_step: discuss
        from_artifact: output/decomposition-plan.md
        to_artifact: incoming-brief.md
  output:
    from_step: write
    artifact: final-draft.md
`)

    const result = parseWorkflowTemplate(templatePath)
    assert.equal(result.errors.length, 0)
    assert.ok(result.template)
    assert.equal(result.template?.steps[1]?.brief_prefix?.trim(), 'Use executive-summary.')
    assert.equal(result.template?.steps[1]?.include_initial_brief, true)
    assert.equal(result.template?.steps[1]?.brief_suffix?.trim(), 'Use strategic-consulting.')
  })
})

test('parseWorkflowTemplate preserves idempotent Markdown-to-DOCX publication contracts', () => {
  withTempDir((dir) => {
    const templatePath = path.join(dir, 'publish.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: publish
  steps:
    - id: publish-report
      type: transform
      transform: markdown_to_docx
      input_artifact: final-draft.md
      result_artifact: final-report.md
      result_artifacts:
        - final-report.docx
  output:
    from_step: publish-report
    artifact: final-report.md
    secondary_artifacts:
      - artifact: final-report.docx
        media_type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
        label: Word document
`)

    const parsed = parseWorkflowTemplate(templatePath)
    assert.deepEqual(parsed.errors, [])
    assert.ok(parsed.template)
    assert.equal(parsed.template.steps[0]?.team, BUILTIN_TRANSFORM_EXECUTOR)
    assert.equal(parsed.template.steps[0]?.recovery_policy, 'idempotent')
    assert.deepEqual(parsed.template.steps[0]?.result_artifacts, ['final-report.docx'])
    assert.deepEqual(parsed.template.output.secondary_artifacts, [{
      artifact: 'final-report.docx',
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      label: 'Word document',
    }])
    assert.deepEqual(validateWorkflowTemplate(parsed.template, new Map()), [])
  })
})

test('parseWorkflowTemplate accepts profile-driven Generate Word transforms', () => {
  const parsed = parseWorkflowTemplateYaml(`
workflow:
  id: generate-word
  steps:
    - id: publish
      type: transform
      transform: generate_word
      input_artifact: final-draft.md
      result_artifact: final-report.docx
      word:
        profile: proposal
        table_of_contents: false
        render_mermaid: true
        mermaid_failure: keep-code
  output:
    from_step: publish
    artifact: final-report.docx
`, 'generate-word.yaml')

  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.template?.steps[0]?.word, {
    profile: 'proposal',
    table_of_contents: false,
    render_mermaid: true,
    mermaid_failure: 'keep-code',
  })
  assert.deepEqual(
    validateWorkflowTemplate(parsed.template!, new Map()),
    [],
  )
})

test('parseWorkflowTemplate accepts profile and template Generate Excel transforms', () => {
  const parsed = parseWorkflowTemplateYaml(`
workflow:
  id: generate-excel
  steps:
    - id: publish
      type: transform
      transform: generate_excel
      input_artifact: final-draft.md
      result_artifact: final-report.xlsx
      excel:
        profile: financial-model
  output:
    from_step: publish
    artifact: final-report.xlsx
`, 'generate-excel.yaml')

  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.template?.steps[0]?.excel, {
    profile: 'financial-model',
  })
  assert.deepEqual(
    validateWorkflowTemplate(parsed.template!, new Map()),
    [],
  )

  const templated = parseWorkflowTemplateYaml(`
workflow:
  id: generate-excel-template
  steps:
    - id: publish
      type: transform
      transform: generate_excel
      input_artifact: risk-data.json
      result_artifact: risk-report.xlsx
      excel:
        template: risk-register
  output:
    from_step: publish
    artifact: risk-report.xlsx
`, 'generate-excel-template.yaml')

  assert.deepEqual(templated.errors, [])
  assert.equal(templated.template?.steps[0]?.excel?.template, 'risk-register')
})

test('parseWorkflowTemplate rejects malformed Generate Excel options', () => {
  const parsed = parseWorkflowTemplateYaml(`
workflow:
  id: invalid-generate-excel
  steps:
    - id: publish
      type: transform
      transform: generate_excel
      input_artifact: final-draft.md
      result_artifact: final-report.xlsx
      excel:
        profile: financial-model
        template: risk-register
        unsupported_option: true
  output:
    from_step: publish
    artifact: final-report.xlsx
`, 'invalid-generate-excel.yaml')

  assert.match(parsed.errors.join('\n'), /unsupported_option is not supported/)
  assert.match(parsed.errors.join('\n'), /cannot set both profile and template/)
})

test('parseWorkflowTemplate rejects malformed Generate Word options', () => {
  const parsed = parseWorkflowTemplateYaml(`
workflow:
  id: invalid-generate-word
  steps:
    - id: publish
      type: transform
      transform: generate_word
      input_artifact: final-draft.md
      result_artifact: final-report.docx
      word:
        render_mermaid: sometimes
        unsupported_option: true
  output:
    from_step: publish
    artifact: final-report.docx
`, 'invalid-generate-word.yaml')

  assert.match(parsed.errors.join('\n'), /unsupported_option is not supported/)
  assert.match(parsed.errors.join('\n'), /render_mermaid must be a boolean/)
})

test('parseWorkflowTemplate preserves a transform provenance handoff', () => {
  const parsed = parseWorkflowTemplateYaml(`
workflow:
  id: provenance-publication
  steps:
    - id: research
      type: team
      team: research-team
      input_artifact: incoming-brief.md
      result_artifact: research-package.md
    - id: publish
      type: transform
      transform: markdown_to_docx
      input_artifact: final-draft.md
      result_artifact: final-report.md
      result_artifacts:
        - final-report.docx
      provenance_handoff:
        from_step: research
        from_artifact: research-package.md
  output:
    from_step: publish
    artifact: final-report.md
`, 'provenance-publication.yaml')

  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.template?.steps[1]?.provenance_handoff, {
    from_step: 'research',
    from_artifact: 'research-package.md',
  })
})

test('validateWorkflowTemplate binds provenance to a safe declared prior artifact', () => {
  const teamRegistry = new Map<string, TeamRegistryEntry>([
    ['research-team', {
      name: 'research-team',
      type: 'team',
      team_path: RESEARCH_TEAM_PATH,
    }],
  ])
  const validTemplate = {
    id: 'provenance-contract',
    steps: [
      {
        id: 'research',
        type: 'team' as const,
        team: 'research-team',
        input_artifact: 'incoming-brief.md',
        result_artifact: 'research-package.md',
      },
      {
        id: 'publish',
        type: 'transform' as const,
        team: BUILTIN_TRANSFORM_EXECUTOR,
        transform: 'markdown_to_docx' as const,
        input_artifact: 'final-draft.md',
        result_artifact: 'final-report.md',
        result_artifacts: ['final-report.docx'],
        recovery_policy: 'idempotent' as const,
        provenance_handoff: {
          from_step: 'research',
          from_artifact: 'research-package.md',
        },
      },
    ],
    output: { from_step: 'publish', artifact: 'final-report.md' },
  }

  assert.deepEqual(validateWorkflowTemplate(validTemplate, teamRegistry), [])

  const missingStep = structuredClone(validTemplate)
  missingStep.steps[1]!.provenance_handoff!.from_step = 'missing'
  assert.match(
    validateWorkflowTemplate(missingStep, teamRegistry).join('\n'),
    /provenance_handoff references prior step 'missing'/,
  )

  const undeclaredArtifact = structuredClone(validTemplate)
  undeclaredArtifact.steps[1]!.provenance_handoff!.from_artifact = 'other.md'
  assert.match(
    validateWorkflowTemplate(undeclaredArtifact, teamRegistry).join('\n'),
    /provenance_handoff\.from_artifact .* does not match an artifact declared/,
  )

  const escapingArtifact = structuredClone(validTemplate)
  escapingArtifact.steps[1]!.provenance_handoff!.from_artifact = '../research-package.md'
  assert.match(
    validateWorkflowTemplate(escapingArtifact, teamRegistry).join('\n'),
    /provenance_handoff\.from_artifact must be a safe assignment-relative artifact path/,
  )
})

test('validateWorkflowTemplate rejects incomplete or non-idempotent DOCX transforms', () => {
  const errors = validateWorkflowTemplate({
    id: 'broken-publish',
    steps: [{
      id: 'publish',
      type: 'transform',
      team: BUILTIN_TRANSFORM_EXECUTOR,
      transform: 'markdown_to_docx',
      input_artifact: 'draft.md',
      result_artifact: 'report.md',
      recovery_policy: 'manual',
      mcp_requirements: [{
        capability: 'documents',
        access: ['write'],
        necessity: 'required',
      }],
    }],
    output: { from_step: 'publish', artifact: 'report.md' },
  } as any, new Map())

  assert.ok(errors.some((error) => /DOCX result artifact/.test(error)))
  assert.ok(errors.some((error) => /recovery_policy must be 'idempotent'/.test(error)))
  assert.ok(errors.some((error) => /must not declare mcp_requirements/.test(error)))
})

test('validateWorkflowTemplate rejects non-Markdown transform input, primary output, and unsupported formats', () => {
  const parsed = parseWorkflowTemplateYaml(`
workflow:
  id: invalid-publication-shapes
  steps:
    - id: publish
      type: transform
      transform: markdown_to_docx
      input_artifact: source.docx
      result_artifact: final-report.docx
      result_artifacts:
        - final-report.md
        - final-report.pdf
  output:
    from_step: publish
    artifact: final-report.docx
`, 'invalid-publication-shapes.yaml')
  assert.ok(parsed.template)

  const errors = validateWorkflowTemplate(parsed.template!, new Map())
  assert.ok(errors.some((error) => /primary result_artifact must be Markdown/.test(error)))
  assert.ok(errors.some((error) => /input artifact must be Markdown/.test(error)))
  assert.ok(errors.some((error) => /cannot produce 'final-report\.pdf'/.test(error)))
})

test('validateWorkflowTemplate rejects unknown workflow teams and bad handoffs', () => {
  const teamRegistry = new Map<string, TeamRegistryEntry>([
    ['writing-team', { name: 'writing-team', type: 'team', team_path: WRITING_TEAM_PATH }],
  ])
  const template = {
    id: 'broken-workflow',
    steps: [
      {
        id: 'write',
        type: 'team' as const,
        team: 'writing-team',
        input_artifact: 'incoming-brief.md',
        result_artifact: 'final-draft.md',
      },
      {
        id: 'review',
        type: 'team' as const,
        team: 'editor-team',
        input_artifact: 'incoming-brief.md',
        result_artifact: 'final.md',
        handoff: {
          from_step: 'missing',
          from_artifact: 'draft.md',
          to_artifact: 'incoming-brief.md',
        },
      },
    ],
    output: {
      from_step: 'review',
      artifact: 'final.md',
    },
  }

  const errors = validateWorkflowTemplate(template as any, teamRegistry)
  assert.equal(errors.length, 2)
  assert.match(errors[0]!, /unknown team 'editor-team'/)
  assert.match(errors[1]!, /handoff references prior step 'missing'/)
})

test('parse and validation preserve explicit workflow recovery policies', () => {
  withTempDir((dir) => {
    const templatePath = path.join(dir, 'recovery-policy.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: recovery-policy
  steps:
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      recovery_policy: manual
  output:
    from_step: write
    artifact: final-draft.md
`)

    const parsed = parseWorkflowTemplate(templatePath)
    assert.equal(parsed.errors.length, 0)
    assert.equal(parsed.template?.steps[0]?.recovery_policy, 'manual')

    const teamRegistry = new Map<string, TeamRegistryEntry>([
      ['writing-team', { name: 'writing-team', type: 'team', team_path: WRITING_TEAM_PATH }],
    ])
    parsed.template!.steps[0]!.recovery_policy = 'unsafe' as never
    assert.match(
      validateWorkflowTemplate(parsed.template!, teamRegistry).join('\n'),
      /recovery_policy must be/,
    )
  })
})

test('validateWorkflowTemplate enforces artifact handoff and output contracts', () => {
  const teamRegistry = new Map<string, TeamRegistryEntry>([
    ['writing-team', { name: 'writing-team', type: 'team', team_path: WRITING_TEAM_PATH }],
  ])
  const template = {
    id: 'unsafe-contracts',
    steps: [
      {
        id: 'draft',
        type: 'team' as const,
        team: 'writing-team',
        input_artifact: 'incoming.md',
        result_artifact: 'output/draft.md',
      },
      {
        id: 'publish',
        type: 'team' as const,
        team: 'writing-team',
        input_artifact: 'incoming.md',
        result_artifact: '../final.md',
        handoff: {
          from_step: 'draft',
          from_artifact: 'output/other.md',
          to_artifact: 'different.md',
        },
      },
    ],
    output: {
      from_step: 'publish',
      artifact: 'final.md',
    },
    on_failed: 'ignore',
  }

  const errors = validateWorkflowTemplate(template as any, teamRegistry)
  assert.ok(errors.some((error) => /result_artifact must be a safe/.test(error)))
  assert.ok(errors.some((error) => /from_artifact .* does not match/.test(error)))
  assert.ok(errors.some((error) => /to_artifact .* does not match/.test(error)))
  assert.ok(errors.some((error) => /output\.artifact .* does not match/.test(error)))
  assert.ok(errors.some((error) => /on_failed must be/.test(error)))
})

test('validateWorkflowTemplate rejects unreadable referenced team configs', () => {
  withTempDir((dir) => {
    const missingTeamPath = path.join(dir, 'missing-team')
    const teamRegistry = new Map<string, TeamRegistryEntry>([
      ['missing-team', { name: 'missing-team', type: 'team', team_path: missingTeamPath }],
    ])
    const template = {
      id: 'unlaunchable-team-config',
      steps: [
        {
          id: 'run-missing-team',
          type: 'team' as const,
          team: 'missing-team',
          input_artifact: 'incoming-brief.md',
          result_artifact: 'final.md',
        },
      ],
      output: {
        from_step: 'run-missing-team',
        artifact: 'final.md',
      },
    }

    const errors = validateWorkflowTemplate(template as any, teamRegistry)
    assert.ok(
      errors.some((error) =>
        error.includes("cannot load team 'missing-team' configuration"),
      ),
    )
  })
})

test('validateWorkflowTemplate rejects discussion overrides on non-discussion levels', () => {
  withTempDir((dir) => {
    const teamDir = path.join(dir, 'routing-team')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.writeFileSync(path.join(teamDir, 'team.yaml'), `
team:
  name: routing-team
  description: Routes requests
  version: '0.1.0'
agents:
  - name: router
    type: agent
    role: Routes
    agent_file: router.md
    produces:
      - path: routing-decision.md
levels:
  - id: intake
    name: Intake
    order: 0
    stage:
      type: routing
      coordinator: router
      config:
        output:
          format: routing-decision.md
          user_review: false
gates:
  - from: intake
    to: done
    condition:
      type: artifact_exists
      artifact: routing-decision.md
`)

    const teamRegistry = new Map<string, TeamRegistryEntry>([
      ['routing-team', { name: 'routing-team', type: 'team', team_path: teamDir }],
    ])
    const template = {
      id: 'bad-overrides',
      steps: [
        {
          id: 'clarify',
          type: 'team' as const,
          team: 'routing-team',
          input_artifact: 'incoming-brief.md',
          result_artifact: 'output/clarified-brief.md',
          runtime_overrides: {
            levels: {
              intake: {
                discussion: {
                  participants: ['router'],
                  min_rounds: 1,
                  max_rounds: 1,
                },
              },
            },
          },
        },
      ],
      output: {
        from_step: 'clarify',
        artifact: 'output/clarified-brief.md',
      },
    }

    const errors = validateWorkflowTemplate(template as any, teamRegistry)
    assert.ok(
      errors.some((error) =>
        error.includes("runtime_overrides level 'intake' declares discussion settings") &&
        error.includes("level is type 'routing'"),
      ),
    )
    assert.ok(
      errors.some((error) =>
        error.includes("result_artifact 'output/clarified-brief.md'") &&
        error.includes("completion artifact 'routing-decision.md'"),
      ),
    )
  })
})
