import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  saveWorkflow,
  saveWorkflowYaml,
  updateExistingWorkflowYaml,
} from '../../domains/workflow-generator/save-workflow.js'
import type { WorkflowDraft } from '../../domains/workflow-generator/workflow-draft.js'
import { parseWorkflowRegistry, parseWorkflowTemplate } from '../../workflows/loader.js'

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-save-'))
  return Promise.resolve(fn(dir)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

const draft: WorkflowDraft = {
  id: 'ai-suggested-workflow',
  description: 'Generate a final draft from an incoming request.',
  matches: ['write draft'],
  input: { artifact: 'incoming-request.md' },
  steps: [
    {
      id: 'write',
      type: 'team',
      team: 'writing-team',
      input_artifact: 'incoming-brief.md',
      result_artifact: 'final-draft.md',
    },
  ],
  output: { from_step: 'write', artifact: 'final-draft.md' },
  on_blocked: 'stop',
  on_failed: 'stop',
}

test('saveWorkflow uses the user filename as the persisted workflow id', async () => {
  await withTempDir(async (repoRoot) => {
    const result = await saveWorkflow({
      draft,
      filename: 'test one to three',
      repoRoot,
    })

    assert.equal(result.filename, 'test-one-to-three.yaml')

    const template = parseWorkflowTemplate(result.yamlPath).template
    assert.ok(template)
    assert.equal(template.id, 'test-one-to-three')

    const registry = parseWorkflowRegistry(path.join(repoRoot, 'workflows', 'registry.yaml'))
    assert.deepEqual(registry.errors, [])
    assert.equal(registry.entries.length, 1)
    assert.equal(requiredValue(registry.entries[0], 'tests/unit/workflow-generator-save.test.ts:58').name, 'test-one-to-three')
    assert.equal(
      requiredValue(registry.entries[0], 'tests/unit/workflow-generator-save.test.ts:60').template_path,
      path.join(repoRoot, 'workflows', 'user-generated', 'test-one-to-three.yaml'),
    )
  })
})

test('saveWorkflowYaml uses the filename as the workflow id without rebuilding the YAML body', async () => {
  await withTempDir(async (repoRoot) => {
    const yaml = `workflow:
  id: manually-edited-workflow
  description: Edited directly in the YAML panel.
  matches:
    - edited yaml
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`

    const result = await saveWorkflowYaml({
      yaml,
      filename: 'manual file name',
      repoRoot,
    })

    assert.equal(result.filename, 'manual-file-name.yaml')
    const savedYaml = fs.readFileSync(result.yamlPath, 'utf8')
    assert.match(savedYaml, /id: manual-file-name/)
    assert.match(savedYaml, /description: Edited directly in the YAML panel\./)
    assert.match(savedYaml, /- edited yaml/)

    const template = parseWorkflowTemplate(result.yamlPath).template
    assert.ok(template)
    assert.equal(template.id, 'manual-file-name')

    const registry = parseWorkflowRegistry(path.join(repoRoot, 'workflows', 'registry.yaml'))
    assert.deepEqual(registry.errors, [])
    assert.equal(registry.entries.length, 1)
    assert.equal(requiredValue(registry.entries[0], 'tests/unit/workflow-generator-save.test.ts:107').name, 'manual-file-name')
    assert.equal(
      requiredValue(registry.entries[0], 'tests/unit/workflow-generator-save.test.ts:109').template_path,
      path.join(repoRoot, 'workflows', 'user-generated', 'manual-file-name.yaml'),
    )
  })
})

test('saveWorkflowYaml keeps the YAML workflow id when no filename is provided', async () => {
  await withTempDir(async (repoRoot) => {
    const yaml = `workflow:
  id: ai-generated-name
  description: Save under the generated workflow id.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`

    const result = await saveWorkflowYaml({
      yaml,
      repoRoot,
    })

    assert.equal(result.filename, 'ai-generated-name.yaml')

    const template = parseWorkflowTemplate(result.yamlPath).template
    assert.ok(template)
    assert.equal(template.id, 'ai-generated-name')

    const registry = parseWorkflowRegistry(path.join(repoRoot, 'workflows', 'registry.yaml'))
    assert.deepEqual(registry.errors, [])
    assert.equal(registry.entries.length, 1)
    assert.equal(requiredValue(registry.entries[0], 'tests/unit/workflow-generator-save.test.ts:149').name, 'ai-generated-name')
  })
})

test('saveWorkflowYaml can replace a renamed registry entry', async () => {
  await withTempDir(async (repoRoot) => {
    const workflowsDir = path.join(repoRoot, 'workflows')
    fs.mkdirSync(workflowsDir, { recursive: true })
    fs.writeFileSync(path.join(workflowsDir, 'registry.yaml'), `old-name:
  description: Old description.
  template_path: ./user-generated/old-name.yaml
`)

    const result = await saveWorkflowYaml({
      yaml: `workflow:
  id: new-name
  description: New description.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`,
      replaceWorkflowId: 'old-name',
      repoRoot,
    })

    assert.equal(result.filename, 'new-name.yaml')
    const registry = parseWorkflowRegistry(path.join(workflowsDir, 'registry.yaml'))
    assert.deepEqual(registry.entries.map((entry) => entry.name), ['new-name'])
  })
})

test('updateExistingWorkflowYaml rewrites template and registry metadata', async () => {
  await withTempDir(async (repoRoot) => {
    const workflowsDir = path.join(repoRoot, 'workflows')
    const templatesDir = path.join(workflowsDir, 'templates')
    fs.mkdirSync(templatesDir, { recursive: true })
    const registryPath = path.join(workflowsDir, 'registry.yaml')
    const templatePath = path.join(templatesDir, 'existing.yaml')
    fs.writeFileSync(registryPath, `existing-workflow:
  description: Old description.
  template_path: ./templates/existing.yaml
  tags:
    - old-tag
  capabilities:
    - old-capability
`)
    fs.writeFileSync(templatePath, `workflow:
  id: existing-workflow
  description: Old description.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`)

    const result = await updateExistingWorkflowYaml({
      workflowId: 'existing-workflow',
      registryPath,
      yaml: `workflow:
  id: renamed workflow
  description: New description.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`,
    })

    assert.equal(result.workflowId, 'renamed-workflow')
    assert.equal(result.yamlPath, templatePath)
    assert.match(fs.readFileSync(templatePath, 'utf8'), /id: renamed-workflow/)
    assert.match(fs.readFileSync(templatePath, 'utf8'), /description: New description\./)

    const registry = parseWorkflowRegistry(registryPath)
    assert.deepEqual(registry.errors, [])
    assert.equal(registry.entries.length, 1)
    assert.equal(requiredValue(registry.entries[0], 'tests/unit/workflow-generator-save.test.ts:253').name, 'renamed-workflow')
    assert.deepEqual(requiredValue(registry.entries[0], 'tests/unit/workflow-generator-save.test.ts:254').tags, ['old-tag'])
    assert.deepEqual(requiredValue(registry.entries[0], 'tests/unit/workflow-generator-save.test.ts:255').capabilities, ['old-capability'])
  })
})
