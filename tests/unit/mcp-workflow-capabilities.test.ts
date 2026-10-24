import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  MAX_MCP_WORKFLOW_CAPABILITY_LENGTH,
  MAX_MCP_WORKFLOW_RATIONALE_LENGTH,
  MAX_MCP_WORKFLOW_REQUIREMENTS_PER_SCOPE,
  normalizeMcpWorkflowRequirements,
  requireValidMcpWorkflowRequirements,
} from '../../contracts/mcp-workflow-capabilities.js'
import { renderRegistryBlock } from '../../domains/workflow-generator/generator-prompt.js'
import { loadRegistry } from '../../domains/workflow-generator/registry.js'
import { buildWorkflowYaml } from '../../domains/workflow-generator/yaml-builder.js'
import { parseWorkflowYaml } from '../../domains/workflow-generator/yaml-parser.js'
import { validateDraft } from '../../domains/workflow-generator/validators.js'
import type {
  WorkflowDraft,
  WorkflowGeneratorRegistry,
} from '../../domains/workflow-generator/workflow-draft.js'
import { parseWorkflowTemplate } from '../../workflows/loader.js'

const BASE_YAML = `workflow:
  id: capability-flow
  description: A workflow with optional semantic MCP declarations.
  input:
    artifact: incoming-request.md
  steps:
    - id: research
      type: team
      team: research-team
      input_artifact: incoming-brief.md
      result_artifact: research.md
  output:
    from_step: research
    artifact: research.md
  on_blocked: stop
  on_failed: stop
`

const VALID_REQUIREMENTS_YAML = `workflow:
  id: capability-flow
  description: A workflow with optional semantic MCP declarations.
  mcp_requirements:
    - capability: ' Web.Search '
      access: read
      necessity: required
      rationale: ' Research current sources. '
    - capability: documents.export
      access: write
      necessity: optional
  input:
    artifact: incoming-request.md
  steps:
    - id: research
      type: team
      team: research-team
      mcp_requirements:
        - capability: WEB.SEARCH
          access: write
          necessity: required
          rationale: Produce the step-specific research record.
      input_artifact: incoming-brief.md
      result_artifact: research.md
  output:
    from_step: research
    artifact: research.md
  on_blocked: stop
  on_failed: stop
`

const VALIDATION_REGISTRY: WorkflowGeneratorRegistry = {
  teams: [
    {
      id: 'research-team',
      has_discussion_level: false,
      has_review_level: false,
      level_ids: [],
      agents: [],
    },
  ],
}

test('mcp-workflow-capabilities preserves workflows with no declarations', () => {
  const loaderResult = parseTemplateYaml(BASE_YAML)
  assert.deepEqual(loaderResult.errors, [])
  assert.ok(loaderResult.template)
  assert.equal(loaderResult.template.mcp_requirements, undefined)
  assert.equal(requiredValue(loaderResult.template.steps[0], 'tests/unit/mcp-workflow-capabilities.test.ts:91').mcp_requirements, undefined)

  const draft = parseWorkflowYaml(BASE_YAML)
  assert.equal(draft.mcp_requirements, undefined)
  assert.equal(requiredValue(draft.steps[0], 'tests/unit/mcp-workflow-capabilities.test.ts:95').mcp_requirements, undefined)
  assert.doesNotMatch(buildWorkflowYaml(draft), /mcp_requirements/)

  const emptyListYaml = BASE_YAML.replace(
    '  input:\n',
    '  mcp_requirements: []\n  input:\n',
  )
  const emptyListResult = parseTemplateYaml(emptyListYaml)
  assert.deepEqual(emptyListResult.errors, [])
  assert.equal(emptyListResult.template?.mcp_requirements, undefined)
  assert.equal(parseWorkflowYaml(emptyListYaml).mcp_requirements, undefined)
})

test('mcp-workflow-capabilities normalizes and round-trips workflow and step declarations', () => {
  const draft = parseWorkflowYaml(VALID_REQUIREMENTS_YAML)
  assert.deepEqual(draft.mcp_requirements, [
    {
      capability: 'documents.export',
      access: 'write',
      necessity: 'optional',
    },
    {
      capability: 'web.search',
      access: 'read',
      necessity: 'required',
      rationale: 'Research current sources.',
    },
  ])
  assert.deepEqual(requiredValue(draft.steps[0], 'tests/unit/mcp-workflow-capabilities.test.ts:123').mcp_requirements, [
    {
      capability: 'web.search',
      access: 'write',
      necessity: 'required',
      rationale: 'Produce the step-specific research record.',
    },
  ])

  const yaml = buildWorkflowYaml(draft)
  assert.ok(yaml.indexOf('capability: documents.export') < yaml.indexOf('capability: web.search'))
  const loaderResult = parseTemplateYaml(yaml)
  assert.deepEqual(loaderResult.errors, [])
  assert.deepEqual(loaderResult.template?.mcp_requirements, draft.mcp_requirements)
  assert.deepEqual(
    requiredValue(loaderResult.template?.steps[0], 'tests/unit/mcp-workflow-capabilities.test.ts:138').mcp_requirements,
    requiredValue(draft.steps[0], 'tests/unit/mcp-workflow-capabilities.test.ts:139').mcp_requirements,
  )
  assert.deepEqual(parseWorkflowYaml(yaml), draft)
})

test('mcp-workflow-capabilities rejects scope-local duplicate capability aliases', () => {
  const yaml = VALID_REQUIREMENTS_YAML.replace(
    '    - capability: documents.export\n      access: write\n      necessity: optional',
    `    - capability: web.search
      access: any
      necessity: optional`,
  )
  const loaderResult = parseTemplateYaml(yaml)
  assert.equal(loaderResult.template, null)
  assert.ok(loaderResult.errors.some((error) =>
    error.includes("duplicate capability 'web.search'"),
  ))

  const draft = parseWorkflowYaml(yaml)
  const validation = validateDraft(draft, VALIDATION_REGISTRY)
  assert.ok(validation.errors.some((error) =>
    error.includes("duplicate capability 'web.search'"),
  ))
})

test('mcp-workflow-capabilities rejects invalid entries and forbidden identity fields', () => {
  const invalidBlock = `  mcp_requirements:
    - web.search
    - capability: 'https://server.example/mcp'
      access: read
      necessity: required
    - capability: billing.charge
      access: execute
      necessity: required
    - capability: reports.generate
      access: write
      necessity: maybe
    - capability: private.server
      access: any
      necessity: optional
      server_id: local-server
    - capability: private.url
      access: any
      necessity: optional
      url: 'https://server.example/mcp'
    - capability: private.credentials
      access: any
      necessity: optional
      credentials: do-not-store
    - capability: private.grant
      access: any
      necessity: optional
      granted: true
`
  const yaml = BASE_YAML.replace('  input:\n', `${invalidBlock}  input:\n`)
  const loaderResult = parseTemplateYaml(yaml)
  assert.equal(loaderResult.template, null)
  for (const expected of [
    'must be an object',
    "capability 'https://server.example/mcp' is invalid",
    ".access must be 'read', 'write', or 'any'",
    ".necessity must be 'required' or 'optional'",
    "unknown key 'server_id'",
    "unknown key 'url'",
    "unknown key 'credentials'",
    "unknown key 'granted'",
  ]) {
    assert.ok(
      loaderResult.errors.some((error) => error.includes(expected)),
      `missing loader error containing ${expected}`,
    )
  }

  const validation = validateDraft(parseWorkflowYaml(yaml), VALIDATION_REGISTRY)
  assert.ok(validation.errors.some((error) => error.includes("unknown key 'server_id'")))
  assert.ok(validation.errors.some((error) => error.includes('must be an object')))
})

test('mcp-workflow-capabilities enforces bounded declaration sizes', () => {
  const tooMany = Array.from(
    { length: MAX_MCP_WORKFLOW_REQUIREMENTS_PER_SCOPE + 1 },
    (_, index) => ({
      capability: `capability-${index}`,
      access: 'read',
      necessity: 'optional',
    }),
  )
  const result = normalizeMcpWorkflowRequirements(
    [
      ...tooMany,
      {
        capability: `a${'b'.repeat(MAX_MCP_WORKFLOW_CAPABILITY_LENGTH)}`,
        access: 'read',
        necessity: 'required',
      },
      {
        capability: 'long-rationale',
        access: 'read',
        necessity: 'optional',
        rationale: 'x'.repeat(MAX_MCP_WORKFLOW_RATIONALE_LENGTH + 1),
      },
    ],
    'workflow.mcp_requirements',
  )
  assert.ok(result.errors.some((error) => error.includes('at most 64 requirements')))
  assert.ok(result.errors.some((error) => error.includes('at most 160 characters')))
  assert.ok(result.errors.some((error) => error.includes('at most 1000 characters')))
  assert.deepEqual(
    normalizeMcpWorkflowRequirements([], 'workflow.mcp_requirements'),
    { errors: [] },
  )
  assert.deepEqual(
    normalizeMcpWorkflowRequirements(null, 'workflow.mcp_requirements').errors,
    ['workflow.mcp_requirements must be a list'],
  )
})

test('mcp-workflow-capabilities keeps workflow and step scopes independent for later stricter resolution', () => {
  const draft = parseWorkflowYaml(VALID_REQUIREMENTS_YAML)
  const validation = validateDraft(draft, VALIDATION_REGISTRY)
  assert.deepEqual(
    validation.errors.filter((error) => error.includes('mcp_requirements')),
    [],
  )

  // Resolution is intentionally deferred: runtime preflight will combine the
  // workflow and step lists and choose stricter access/necessity semantics,
  // rather than treating the step declaration as last-write-wins replacement.
  assert.equal(draft.mcp_requirements?.find((item) => item.capability === 'web.search')?.access, 'read')
  assert.equal(requiredValue(requiredValue(draft.steps[0], 'tests/unit/mcp-workflow-capabilities.test.ts:268').mcp_requirements?.[0], 'tests/unit/mcp-workflow-capabilities.test.ts:269').access, 'write')
})

test('mcp-workflow-capabilities remain visible to the workflow generator registry', () => {
  withTempDir((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '# intentionally empty\n')
    fs.mkdirSync(path.join(repoRoot, 'workflows', 'templates'), { recursive: true })
    fs.writeFileSync(
      path.join(repoRoot, 'workflows', 'registry.yaml'),
      `capability-flow:
  description: Capability-aware workflow.
  template_path: ./templates/capability-flow.yaml
`,
    )
    fs.writeFileSync(
      path.join(repoRoot, 'workflows', 'templates', 'capability-flow.yaml'),
      VALID_REQUIREMENTS_YAML,
    )

    const registry = loadRegistry(repoRoot)
    assert.deepEqual(
      requiredValue(registry.workflow_templates?.[0], 'tests/unit/mcp-workflow-capabilities.test.ts:289').mcp_requirements,
      parseWorkflowYaml(VALID_REQUIREMENTS_YAML).mcp_requirements,
    )
    assert.deepEqual(
      requiredValue(requiredValue(registry.workflow_templates?.[0], 'tests/unit/mcp-workflow-capabilities.test.ts:293').steps?.[0], 'tests/unit/mcp-workflow-capabilities.test.ts:294').mcp_requirements,
      requiredValue(parseWorkflowYaml(VALID_REQUIREMENTS_YAML).steps[0], 'tests/unit/mcp-workflow-capabilities.test.ts:294').mcp_requirements,
    )
    const prompt = renderRegistryBlock({
      ...registry,
      teams: VALIDATION_REGISTRY.teams,
    })
    assert.match(prompt, /capability=web\.search; access=read; necessity=required/)
    assert.match(prompt, /capability=web\.search; access=write; necessity=required/)
  })
})

test('mcp-workflow-capabilities builder refuses invalid programmatic declarations', () => {
  const draft = parseWorkflowYaml(BASE_YAML)
  const invalid = {
    ...draft,
    mcp_requirements: [
      {
        capability: 'web.search',
        access: 'read',
        necessity: 'required',
        server_id: 'forbidden',
      },
    ],
  } as unknown as WorkflowDraft
  assert.throws(
    () => buildWorkflowYaml(invalid),
    /unknown key 'server_id'/,
  )
})

function parseTemplateYaml(yaml: string): ReturnType<typeof parseWorkflowTemplate> {
  return withTempDir((dir) => {
    const filePath = path.join(dir, 'workflow.yaml')
    fs.writeFileSync(filePath, yaml)
    return parseWorkflowTemplate(filePath)
  })
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-workflow-capabilities-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
