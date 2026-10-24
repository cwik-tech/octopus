import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { whenDefined } from '../../core/optional-properties.js'

import { approveResearchPlan } from '../../domains/deep-research/deep-research-approval.js'
import { buildResearchEvidenceGraph } from '../../domains/deep-research/deep-research-evidence-graph.js'
import { buildResearchPublicationAudit } from '../../domains/deep-research/deep-research-publication-audit.js'
import { buildResearchSynthesisPacket } from '../../domains/deep-research/deep-research-quality.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { runWorkflow, type WorkflowRunnerOptions } from '../../workflows/runner.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
  readWorkflowCompletionReceipt,
} from '../../workflows/workflow-state-store.js'
import { BUILTIN_TRANSFORM_EXECUTOR } from '../../workflows/artifact-contracts.js'
import {
  makeEvidencePacket,
  makePlan,
  makeSource,
  TEST_TIME,
} from '../unit/deep-research-fixtures.js'

test('Team chat completes without requiring or publishing a deliverable artifact', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-team-chat-no-artifact-'))
  try {
    const templatePath = path.join(workspace, 'team-chat.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: team-chat-no-artifact
  steps:
    - id: discuss
      type: team
      team: chat-team
      input_artifact: incoming-brief.md
      result_artifact: board-result.md
  output:
    from_step: discuss
    artifact: board-result.md
`)
    const result = await runWorkflow({
      workflowEntry: { name: 'team-chat-no-artifact', template_path: templatePath },
      teamRegistry: new Map([['chat-team', {
        name: 'chat-team',
        type: 'team' as const,
        team_path: path.join(process.cwd(), 'tests', 'fixtures', 'team-chat-e2e', 'teams', 'board-team'),
        input_artifact: 'incoming-brief.md',
        output_artifact: 'board-result.md',
      }]]),
      brief: 'Continue our mining discussion.',
      workspacePath: workspace,
      spawnDepth: 0,
      executionMode: 'team-chat',
      persistenceMode: 'required',
      taskId: 'task-team-chat-no-artifact',
      productSessionId: 'session-team-chat-no-artifact',
      rootSessionId: 'root-team-chat-no-artifact',
      executionAttemptId: 'attempt-team-chat-no-artifact',
      runTeamImpl: async (options) => {
        assert.ok(options.childSessionId)
        assert.equal(options.executionMode, 'team-chat')
        const assignmentPath = path.join(workspace, 'assignments', options.childSessionId)
        fs.mkdirSync(assignmentPath, { recursive: true })
        return {
          text: 'Team members replied in chat.',
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath: '',
          assignmentPath,
          childSessionId: options.childSessionId,
          status: 'completed',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.equal(result.status, 'completed', result.summary)
    assert.equal(result.primaryArtifact, undefined)
    assert.deepEqual(result.artifacts, [])
    assert.equal(result.requestedResultType, 'chat:messages')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('generate_word workflow transform can publish DOCX as its primary artifact', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-generate-word-'))
  try {
    const templatePath = path.join(workspace, 'generate-word.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: generate-word-primary
  steps:
    - id: publish
      type: transform
      transform: generate_word
      input_artifact: report.md
      result_artifact: report.docx
      word:
        profile: executive-summary
        table_of_contents: false
        render_mermaid: false
  output:
    from_step: publish
    artifact: report.docx
`)
    const result = await runWorkflow({
      workflowEntry: {
        name: 'generate-word-primary',
        template_path: templatePath,
      },
      teamRegistry: new Map(),
      brief: '# Executive result\n\n## Decision\n\nProceed with the plan.\n',
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'task-generate-word',
      productSessionId: 'session-generate-word',
      rootSessionId: 'root-generate-word',
      executionAttemptId: 'attempt-generate-word',
    })
    assert.equal(result.status, 'completed')
    assert.equal(path.basename(result.primaryArtifact!), 'report.docx')
    assert.equal(result.artifacts?.[0]?.role, 'primary')
    assert.equal(
      fs.readFileSync(result.artifacts![0]!.artifactPath)
        .subarray(0, 2)
        .toString('ascii'),
      'PK',
    )
    assert.equal(result.steps[0]?.cost, 0)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('YouTube manual workflow delivers every generated Word manual', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-youtube-manual-delivery-'))
  try {
    const templatePath = path.join(workspace, 'youtube-manual.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: youtube-manual-delivery
  steps:
    - id: generate-manuals
      type: team
      team: youtube-extraction
      input_artifact: incoming-brief.md
      result_artifact: extraction-report.md
      result_artifact_globs:
        - output/manuals/*/*/manual.docx
      optional_result_artifact_globs:
        - output/manuals/*/*/source-video.mp4
  output:
    from_step: generate-manuals
    artifact: extraction-report.md
    secondary_artifact_globs:
      - glob: output/manuals/*/*/manual.docx
        media_type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
        label: Screenshot-rich Word manual
      - glob: output/manuals/*/*/source-video.mp4
        media_type: video/mp4
        label: Downloaded source video
`)
    const registry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    assert.deepEqual(registry.errors, [])
    const teamRegistry = new Map(registry.entries.map((entry) => [entry.name, entry]))

    const result = await runWorkflow({
      workflowEntry: { name: 'youtube-manual-delivery', template_path: templatePath },
      teamRegistry,
      brief: 'Create a manual.',
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'task-youtube-manual-delivery',
      productSessionId: 'session-youtube-manual-delivery',
      rootSessionId: 'root-youtube-manual-delivery',
      executionAttemptId: 'attempt-youtube-manual-delivery',
      runTeamImpl: async (options) => {
        assert.ok(options.childSessionId)
        const assignmentPath = path.join(
          workspace,
          'assignments',
          options.childSessionId,
        )
        const reportPath = path.join(assignmentPath, options.outputArtifact!)
        const manualPath = path.join(
          assignmentPath,
          'output',
          'manuals',
          '4-98WaWtMEI',
          'manual-run-1',
          'manual.docx',
        )
        const videoPath = path.join(path.dirname(manualPath), 'source-video.mp4')
        fs.mkdirSync(path.dirname(reportPath), { recursive: true })
        fs.mkdirSync(path.dirname(manualPath), { recursive: true })
        fs.writeFileSync(reportPath, '# Extraction report\n')
        fs.writeFileSync(manualPath, 'word-document')
        fs.writeFileSync(videoPath, Buffer.from([0, 1, 2, 3]))
        return {
          text: '# Extraction report\n',
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath: reportPath,
          assignmentPath,
          childSessionId: options.childSessionId,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.equal(result.status, 'completed', result.summary)
    assert.deepEqual(result.artifacts?.map((artifact) => ({
      relativePath: artifact.relativePath,
      role: artifact.role,
      label: artifact.label,
    })), [
      { relativePath: 'extraction-report.md', role: 'primary', label: undefined },
      {
        relativePath: 'output/manuals/4-98WaWtMEI/manual-run-1/manual.docx',
        role: 'secondary',
        label: 'Screenshot-rich Word manual',
      },
      {
        relativePath: 'output/manuals/4-98WaWtMEI/manual-run-1/source-video.mp4',
        role: 'secondary',
        label: 'Downloaded source video',
      },
    ])
    const snapshot = await new FileSystemWorkflowStateStore(
      path.join(workspace, 'assignments', 'root-youtube-manual-delivery'),
    ).requireSnapshot()
    assert.deepEqual(
      snapshot.state.terminalOutcome?.artifacts?.map((artifact) => ({
        role: artifact.role,
        relativePath: artifact.artifact.relativePath,
      })),
      [
        { role: 'primary', relativePath: 'extraction-report.md' },
        {
          role: 'secondary',
          relativePath: 'output/manuals/4-98WaWtMEI/manual-run-1/manual.docx',
        },
        {
          role: 'secondary',
          relativePath: 'output/manuals/4-98WaWtMEI/manual-run-1/source-video.mp4',
        },
      ],
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('an optional result glob permits completion when video retention is disabled', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-youtube-video-optional-'))
  try {
    const templatePath = path.join(workspace, 'youtube-manual.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: youtube-manual-video-optional
  steps:
    - id: generate-manuals
      type: team
      team: youtube-extraction
      input_artifact: incoming-brief.md
      result_artifact: extraction-report.md
      optional_result_artifact_globs:
        - output/manuals/*/*/source-video.mp4
  output:
    from_step: generate-manuals
    artifact: extraction-report.md
    secondary_artifact_globs:
      - glob: output/manuals/*/*/source-video.mp4
        media_type: video/mp4
        label: Downloaded source video
`)
    const registry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    const teamRegistry = new Map(registry.entries.map((entry) => [entry.name, entry]))
    const result = await runWorkflow({
      workflowEntry: { name: 'youtube-manual-video-optional', template_path: templatePath },
      teamRegistry,
      brief: 'Create a manual and delete its source video.',
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'task-youtube-manual-video-optional',
      productSessionId: 'session-youtube-manual-video-optional',
      rootSessionId: 'root-youtube-manual-video-optional',
      executionAttemptId: 'attempt-youtube-manual-video-optional',
      runTeamImpl: async (options) => {
        assert.ok(options.childSessionId)
        assert.ok(options.outputArtifact)
        const assignmentPath = path.join(workspace, 'assignments', options.childSessionId)
        const reportPath = path.join(assignmentPath, options.outputArtifact)
        fs.mkdirSync(path.dirname(reportPath), { recursive: true })
        fs.writeFileSync(reportPath, '# Extraction report\n')
        return {
          text: '# Extraction report\n',
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath: reportPath,
          assignmentPath,
          childSessionId: options.childSessionId,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.equal(result.status, 'completed', result.summary)
    assert.deepEqual(result.artifacts?.map((artifact) => artifact.relativePath), [
      'extraction-report.md',
    ])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a declared result glob that matches nothing fails the step instead of delivering an empty run', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-youtube-manual-empty-'))
  try {
    const templatePath = path.join(workspace, 'youtube-manual.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: youtube-manual-empty
  steps:
    - id: generate-manuals
      type: team
      team: youtube-extraction
      input_artifact: incoming-brief.md
      result_artifact: extraction-report.md
      result_artifact_globs:
        - output/manuals/*/*/manual.docx
  output:
    from_step: generate-manuals
    artifact: extraction-report.md
    secondary_artifact_globs:
      - glob: output/manuals/*/*/manual.docx
        label: Screenshot-rich Word manual
`)
    const registry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    const teamRegistry = new Map(registry.entries.map((entry) => [entry.name, entry]))

    const result = await runWorkflow({
      workflowEntry: { name: 'youtube-manual-empty', template_path: templatePath },
      teamRegistry,
      brief: 'Create a manual.',
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'task-youtube-manual-empty',
      productSessionId: 'session-youtube-manual-empty',
      rootSessionId: 'root-youtube-manual-empty',
      executionAttemptId: 'attempt-youtube-manual-empty',
      runTeamImpl: async (options) => {
        const assignmentPath = path.join(workspace, 'assignments', options.childSessionId!)
        const reportPath = path.join(assignmentPath, options.outputArtifact!)
        fs.mkdirSync(path.dirname(reportPath), { recursive: true })
        // The report lands, but no manual is ever produced.
        fs.writeFileSync(reportPath, '# Extraction report\n')
        return {
          text: '# Extraction report\n',
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath: reportPath,
          assignmentPath,
          childSessionId: options.childSessionId!,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.equal(result.status, 'failed')
    assert.match(
      result.steps[0]?.summary ?? '',
      /expected artifacts matching 'output\/manuals\/\*\/\*\/manual\.docx' were not produced/,
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('terminal delivery publishes what the step recorded, not a later view of the directory', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-youtube-manual-drift-'))
  try {
    const templatePath = path.join(workspace, 'youtube-manual.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: youtube-manual-drift
  steps:
    - id: generate-manuals
      type: team
      team: youtube-extraction
      input_artifact: incoming-brief.md
      result_artifact: extraction-report.md
      result_artifact_globs:
        - output/manuals/*/*/manual.docx
    - id: review-manuals
      type: team
      team: writing-team
      input_artifact: extraction-report.md
      result_artifact: final-draft.md
  output:
    from_step: generate-manuals
    artifact: extraction-report.md
    secondary_artifact_globs:
      - glob: output/manuals/*/*/manual.docx
        label: Screenshot-rich Word manual
`)
    const registry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
    const teamRegistry = new Map(registry.entries.map((entry) => [entry.name, entry]))
    let manualsAssignmentPath = ''

    const result = await runWorkflow({
      workflowEntry: { name: 'youtube-manual-drift', template_path: templatePath },
      teamRegistry,
      brief: 'Create a manual.',
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'task-youtube-manual-drift',
      productSessionId: 'session-youtube-manual-drift',
      rootSessionId: 'root-youtube-manual-drift',
      executionAttemptId: 'attempt-youtube-manual-drift',
      runTeamImpl: async (options) => {
        const assignmentPath = path.join(workspace, 'assignments', options.childSessionId!)
        const outputPath = path.join(assignmentPath, options.outputArtifact!)
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })

        if (options.outputArtifact === 'extraction-report.md') {
          manualsAssignmentPath = assignmentPath
          const manualPath = path.join(
            assignmentPath, 'output', 'manuals', 'video-a', 'run-1', 'manual.docx',
          )
          fs.mkdirSync(path.dirname(manualPath), { recursive: true })
          fs.writeFileSync(outputPath, '# Extraction report\n')
          fs.writeFileSync(manualPath, 'word-document')
        } else {
          // Runs after the first step sealed its artifacts. A file appearing in
          // the bundle now must neither be published nor break the durable
          // lookup for the ones that were recorded.
          const strayPath = path.join(
            manualsAssignmentPath, 'output', 'manuals', 'video-a', 'run-2', 'manual.docx',
          )
          fs.mkdirSync(path.dirname(strayPath), { recursive: true })
          fs.writeFileSync(strayPath, 'late-document')
          fs.writeFileSync(outputPath, '# Review\n')
        }

        return {
          text: '# Step output\n',
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath: outputPath,
          assignmentPath,
          childSessionId: options.childSessionId!,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.equal(result.status, 'completed', result.summary)
    assert.deepEqual(
      result.artifacts?.map((artifact) => artifact.relativePath),
      ['extraction-report.md', 'output/manuals/video-a/run-1/manual.docx'],
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a pre-HITL transform journal resumes with its legacy transform manifest hash', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-transform-v1-recovery-'))
  try {
    const templatePath = path.join(workspace, 'transform.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: legacy-transform
  steps:
    - id: publish
      type: transform
      transform: markdown_to_docx
      input_artifact: report.md
      result_artifact: report.md
      result_artifacts:
        - report.docx
  output:
    from_step: publish
    artifact: report.md
`)
    const options: WorkflowRunnerOptions = {
      workflowEntry: { name: 'legacy-transform', template_path: templatePath },
      teamRegistry: new Map(),
      brief: '# Report\n\nA durable transform result.\n',
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'legacy-transform-task',
      productSessionId: 'legacy-transform-session',
      rootSessionId: 'legacy-transform-root',
      executionAttemptId: 'legacy-transform-attempt-one',
    }
    const first = await runWorkflow(options)
    assert.equal(first.status, 'completed')

    const stateStore = new FileSystemWorkflowStateStore(
      path.join(workspace, 'assignments', 'legacy-transform-root'),
    )
    const manifest = JSON.parse(fs.readFileSync(stateStore.paths.manifestPath, 'utf8')) as {
      teamDefinitionHashes: Record<string, string>
    }
    manifest.teamDefinitionHashes = {
      [BUILTIN_TRANSFORM_EXECUTOR]: hashWorkflowContent('markdown-to-docx-v2'),
    }
    fs.writeFileSync(stateStore.paths.manifestPath, JSON.stringify(manifest))

    const legacyState = JSON.parse(fs.readFileSync(stateStore.paths.statePath, 'utf8')) as {
      schemaVersion: number
      steps: Array<Record<string, unknown>>
    }
    legacyState.schemaVersion = 1
    for (const step of legacyState.steps) delete step.stepType
    fs.writeFileSync(stateStore.paths.statePath, JSON.stringify(legacyState))

    const recovered = await runWorkflow({
      ...options,
      executionAttemptId: 'legacy-transform-attempt-two',
      recoveryMode: true,
    })
    assert.equal(recovered.status, 'completed')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('generate_excel workflow transform can publish XLSX as its primary artifact', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-generate-excel-'))
  try {
    const templatePath = path.join(workspace, 'generate-excel.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: generate-excel-primary
  steps:
    - id: publish
      type: transform
      transform: generate_excel
      input_artifact: report.md
      result_artifact: report.xlsx
      excel:
        profile: financial-model
  output:
    from_step: publish
    artifact: report.xlsx
`)
    const result = await runWorkflow({
      workflowEntry: {
        name: 'generate-excel-primary',
        template_path: templatePath,
      },
      teamRegistry: new Map(),
      brief: '# Fund metrics\n\n## Pipeline\n\n| Stage | Deals |\n| --- | ---: |\n| Sourced | 42 |\n',
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'task-generate-excel',
      productSessionId: 'session-generate-excel',
      rootSessionId: 'root-generate-excel',
      executionAttemptId: 'attempt-generate-excel',
    })
    assert.equal(result.status, 'completed')
    assert.equal(path.basename(result.primaryArtifact!), 'report.xlsx')
    assert.equal(result.artifacts?.[0]?.role, 'primary')
    assert.equal(
      fs.readFileSync(result.artifacts![0]!.artifactPath)
        .subarray(0, 2)
        .toString('ascii'),
      'PK',
    )
    assert.equal(result.steps[0]?.cost, 0)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('publication transform durably returns Markdown and a parser-valid DOCX', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-publication-'))
  try {
    const templatePath = path.join(workspace, 'publish.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: publish-report
  steps:
    - id: publish
      type: transform
      transform: markdown_to_docx
      input_artifact: source.md
      result_artifact: final-report.md
      result_artifacts:
        - final-report.docx
  output:
    from_step: publish
    artifact: final-report.md
    secondary_artifacts:
      - artifact: final-report.docx
        media_type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
        label: Word document
`)
    const options: WorkflowRunnerOptions = {
      workflowEntry: {
        name: 'publish-report',
        template_path: templatePath,
      },
      teamRegistry: new Map(),
      brief: `---
artifact_type: report
schema_version: 1
---
# Deep Research Result

## Executive Summary

The observed evidence supports the bounded conclusion.

## Sources

- [Primary source](https://example.com/primary)
`,
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'task-publication',
      productSessionId: 'session-publication',
      rootSessionId: 'root-publication',
      executionAttemptId: 'attempt-one',
    }

    const first = await runWorkflow(options)
    assert.equal(first.status, 'completed')
    assert.deepEqual(first.artifacts?.map((artifact) => ({
      relativePath: artifact.relativePath,
      role: artifact.role,
      mediaType: artifact.mediaType,
    })), [
      {
        relativePath: 'final-report.md',
        role: 'primary',
        mediaType: 'text/markdown',
      },
      {
        relativePath: 'final-report.docx',
        role: 'secondary',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ])

    const markdownPath = first.artifacts?.find(
      (artifact) => artifact.relativePath === 'final-report.md',
    )?.artifactPath
    const docxPath = first.artifacts?.find(
      (artifact) => artifact.relativePath === 'final-report.docx',
    )?.artifactPath
    assert.ok(markdownPath)
    assert.ok(docxPath)
    assert.doesNotMatch(fs.readFileSync(markdownPath, 'utf8'), /artifact_type:/)
    assert.equal(fs.readFileSync(docxPath).subarray(0, 2).toString('ascii'), 'PK')

    const rootAssignment = path.join(workspace, 'assignments', 'root-publication')
    const snapshot = await new FileSystemWorkflowStateStore(rootAssignment).requireSnapshot()
    assert.equal(snapshot.state.steps[0]?.artifacts?.length, 2)
    assert.equal(snapshot.state.terminalOutcome?.artifacts?.length, 2)
    assert.match(snapshot.state.terminalOutcome?.rootWrapperBody ?? '', /final-report\.md \(primary; text\/markdown\)/)
    assert.match(snapshot.state.terminalOutcome?.rootWrapperBody ?? '', /final-report\.docx \(secondary; application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document; Word document\)/)
    const receipt = await readWorkflowCompletionReceipt(first.steps[0]!.assignmentPath)
    assert.equal(receipt?.artifacts?.length, 2)

    const parserOutput = path.join(workspace, 'parsed-docx')
    fs.mkdirSync(parserOutput, { recursive: true })
    const parseScript = [
      "import { parseDocx } from './parsers/docx.ts'",
      'const result = await parseDocx(process.argv[1], process.argv[2])',
      'console.log(JSON.stringify(result))',
    ].join(';')
    const parsed = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', parseScript, docxPath, parserOutput],
      {
        cwd: path.join(process.cwd(), 'file-parser'),
        encoding: 'utf8',
      },
    )
    assert.equal(parsed.status, 0, parsed.stderr)
    const parseResult = JSON.parse(parsed.stdout.trim()) as { status: string; outputs: { text?: string } }
    assert.equal(parseResult.status, 'success')
    assert.ok(parseResult.outputs.text)
    const parsedMarkdown = fs.readFileSync(path.join(parserOutput, parseResult.outputs.text!), 'utf8')
    assert.match(parsedMarkdown, /Deep Research Result/)
    assert.match(parsedMarkdown, /Executive Summary/)
    assert.match(parsedMarkdown, /Primary source/)
    assert.match(parsedMarkdown, /https:\/\/example\.com\/primary/)

    const originalDocxHash = sha256(fs.readFileSync(docxPath))
    const recovered = await runWorkflow({
      ...options,
      executionAttemptId: 'attempt-two',
      recoveryMode: true,
    })
    assert.equal(recovered.status, 'completed')
    assert.equal(recovered.artifacts?.length, 2)
    assert.equal(sha256(fs.readFileSync(docxPath)), originalDocxHash)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('durable publication can select a non-first step artifact as primary', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-publication-docx-primary-'))
  try {
    const templatePath = path.join(workspace, 'publish-docx.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: publish-docx-primary
  steps:
    - id: publish
      type: transform
      transform: markdown_to_docx
      input_artifact: source.md
      result_artifact: final-report.md
      result_artifacts:
        - final-report.docx
  output:
    from_step: publish
    artifact: final-report.docx
    secondary_artifacts:
      - artifact: final-report.md
        media_type: text/markdown
        label: Markdown source
`)
    const result = await runWorkflow({
      workflowEntry: {
        name: 'publish-docx-primary',
        template_path: templatePath,
      },
      teamRegistry: new Map(),
      brief: '# DOCX-first report\n\nEvidence-backed content.\n',
      workspacePath: workspace,
      spawnDepth: 0,
      persistenceMode: 'required',
      taskId: 'task-docx-primary',
      productSessionId: 'session-docx-primary',
      rootSessionId: 'root-docx-primary',
      executionAttemptId: 'attempt-docx-primary',
    })

    assert.equal(result.status, 'completed')
    assert.deepEqual(result.artifacts?.map(({ relativePath, role }) => ({ relativePath, role })), [
      { relativePath: 'final-report.docx', role: 'primary' },
      { relativePath: 'final-report.md', role: 'secondary' },
    ])
    const snapshot = await new FileSystemWorkflowStateStore(
      path.join(workspace, 'assignments', 'root-docx-primary'),
    ).requireSnapshot()
    assert.equal(
      snapshot.state.terminalOutcome?.primaryArtifact?.relativePath,
      'final-report.docx',
    )
    assert.match(
      snapshot.state.terminalOutcome?.rootWrapperBody ?? '',
      /Primary artifact: final-report\.docx/,
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('deep-research publication checks the pre-editorial provenance artifact before writing outputs', async () => {
  const sourcePackage = `# Research package

The measured market reached $1.2B in 2025, with adoption at 18%.

## Limitations and contradictions

The 18% result remains uncertain because the sources disagree.

## Sources

- https://regulator.example/report
- https://research.example/study
`
  const validDraft = `# Final report

Adoption was 18%; the measured market reached $1.2B in 2025
(https://regulator.example/report; https://research.example/study).

## Contradictions and limitations

The sources disagree, so the result remains uncertain.

## Sources

- https://research.example/study
- https://regulator.example/report
`
  const registry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
  assert.deepEqual(registry.errors, [])
  const teamRegistry = new Map(registry.entries.map((entry) => [entry.name, entry]))
  const templatePath = path.join(
    process.cwd(),
    'workflows',
    'templates',
    'deep-research-to-document.yaml',
  )
  const approvedPlan = approveResearchPlan(makePlan(), TEST_TIME)
  const synthesis = buildResearchSynthesisPacket({
    plan: approvedPlan,
    evidencePackets: [makeEvidencePacket({
      sources: [
        makeSource({
          sourceId: 'source-regulator',
          canonicalUrl: 'https://regulator.example/report',
          publisher: 'Regulator',
          independenceKey: 'regulator',
          sourceType: 'regulatory',
        }),
        makeSource({
          sourceId: 'source-research',
          canonicalUrl: 'https://research.example/study',
          publisher: 'Research Institute',
          independenceKey: 'research-institute',
          sourceType: 'academic',
        }),
      ],
    })],
  })
  const evidenceGraph = buildResearchEvidenceGraph({
    plan: approvedPlan,
    synthesis,
    correctionWave: 0,
  })

  async function execute(editorialDraft: string, workspace: string) {
    let callCount = 0
    return runWorkflow({
      workflowEntry: { name: 'deep-research-report', template_path: templatePath },
      teamRegistry,
      brief: 'Execute the approved research plan.',
      workspacePath: workspace,
      spawnDepth: 0,
      runTeamImpl: async (options) => {
        callCount += 1
        const body = callCount === 1 ? sourcePackage : editorialDraft
        const assignmentPath = path.join(workspace, `team-assignment-${callCount}`)
        const artifactPath = path.join(assignmentPath, options.outputArtifact!)
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, body)
        if (callCount === 1) {
          const graphPath = path.join(
            assignmentPath,
            'research',
            'evidence-graph',
            'current.json',
          )
          fs.mkdirSync(path.dirname(graphPath), { recursive: true })
          fs.writeFileSync(
            graphPath,
            `${JSON.stringify(evidenceGraph, null, 2)}\n`,
          )
        } else {
          const audit = buildResearchPublicationAudit({
            sourceMarkdown: sourcePackage,
            publicationMarkdown: editorialDraft,
            evidenceGraph,
            auditedAt: TEST_TIME,
          })
          fs.writeFileSync(
            path.join(assignmentPath, 'publication-audit.json'),
            `${JSON.stringify(audit, null, 2)}\n`,
          )
        }
        return {
          text: body,
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath,
          assignmentPath,
          childSessionId: `team-child-${callCount}`,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed' as const,
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })
  }

  const validWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-provenance-valid-'))
  try {
    const valid = await execute(validDraft, validWorkspace)
    assert.equal(valid.status, 'completed')
    assert.equal(valid.steps.length, 3)
    assert.ok(valid.artifacts?.some(
      (artifact) => artifact.relativePath === 'final-report.docx',
    ))
  } finally {
    fs.rmSync(validWorkspace, { recursive: true, force: true })
  }

  // A draft that drops a validated source is repaired, not rejected: citation
  // canonicalization regenerates the Sources section from the evidence graph.
  // The numeric claim keeps a validated citation, so no evidence is lost.
  const repairedWorkspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-provenance-repaired-'),
  )
  try {
    const repaired = await execute(
      validDraft
        .replace('; https://research.example/study', '')
        .replace('- https://research.example/study\n', ''),
      repairedWorkspace,
    )
    assert.equal(repaired.status, 'completed')
    const reportPath = fs.readdirSync(repairedWorkspace, { recursive: true })
      .find(
        (artifact) =>
          typeof artifact === 'string' && /final-report\.md$/u.test(artifact),
      )
    assert.ok(typeof reportPath === 'string', 'expected a published report')
    const report = fs.readFileSync(
      path.join(repairedWorkspace, reportPath),
      'utf8',
    )
    assert.match(report, /- \[.+\]\(https:\/\/research\.example\/study\)/u)

    // The repair must be recorded in the published audit, not merely visible
    // in the output: a Sources section regenerated without a canonicalization
    // summary would fail these assertions.
    const auditPaths = fs.readdirSync(repairedWorkspace, { recursive: true })
      .filter(
        (artifact): artifact is string =>
          typeof artifact === 'string' &&
          /publication-audit\.json$/u.test(artifact),
      )
    const audits = auditPaths.map((auditPath) =>
      JSON.parse(
        fs.readFileSync(path.join(repairedWorkspace, auditPath), 'utf8'),
      ) as { canonicalization?: Record<string, unknown> },
    )
    const canonicalAudit = audits.find(
      (audit) => audit.canonicalization !== undefined,
    )
    assert.ok(
      canonicalAudit,
      'expected a publication audit recording canonicalization',
    )
    assert.deepEqual(canonicalAudit!.canonicalization!.graphUrlBaseline, [
      'https://regulator.example/report',
      'https://research.example/study',
    ])
    assert.deepEqual(
      canonicalAudit!.canonicalization!.publicationUrlInventory,
      [
        'https://regulator.example/report',
        'https://research.example/study',
      ],
    )
    assert.deepEqual(
      canonicalAudit!.canonicalization!.removedSourceSectionHeadings,
      ['Sources'],
    )
    assert.equal(canonicalAudit!.canonicalization!.generatedSourceCount, 2)
    assert.deepEqual(canonicalAudit!.canonicalization!.removedUnknownUrls, [])
  } finally {
    fs.rmSync(repairedWorkspace, { recursive: true, force: true })
  }

  // Claim-local evidence loss still blocks publication before any output.
  const invalidWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-provenance-invalid-'))
  try {
    await assert.rejects(
      execute(
        validDraft.replace(
          '(https://regulator.example/report; https://research.example/study)',
          '',
        ),
        invalidWorkspace,
      ),
      /Post-editorial provenance check failed: .*numeric claim paragraph/u,
    )
    const artifacts = fs.readdirSync(invalidWorkspace, { recursive: true })
    assert.equal(
      artifacts.some(
        (artifact) =>
          typeof artifact === 'string' &&
          /final-report\.(?:md|docx)$/u.test(artifact),
      ),
      false,
    )
  } finally {
    fs.rmSync(invalidWorkspace, { recursive: true, force: true })
  }
})

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

test('requested Markdown is the primary delivery and an internal report cannot replace a missing document', async (t) => {
  for (const hasManual of [true, false]) await t.test(hasManual ? 'delivers the illustrated document' : 'rejects a report alone', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'requested-md-delivery-'))
    try {
      const templatePath = path.join(workspace, 'requested.yaml')
      fs.writeFileSync(templatePath, `workflow:
  id: requested-document
  steps:
    - id: generate
      type: team
      team: youtube-extraction
      input_artifact: incoming-brief.md
      result_artifact: extraction-report.md
      optional_result_artifact_globs:
        - output/manuals/*/*/manual.md
        - output/manuals/*/*/manual.zip
  output:
    from_step: generate
    artifact: extraction-report.md
    primary_artifact_globs:
      - glob: output/manuals/*/*/manual.md
    secondary_artifact_globs:
      - glob: output/manuals/*/*/manual.zip
`)
      const registry = parseTeamRegistry(path.join(process.cwd(), 'teams.yaml'))
      const result = await runWorkflow({
        workflowEntry: { name: 'requested-document', template_path: templatePath },
        teamRegistry: new Map(registry.entries.map((entry) => [entry.name, entry])),
        brief: 'Create an MD file with screenshots and key takeaways.', workspacePath: workspace, spawnDepth: 0,
        // Paid LLM boundary only; real workflow sealing and filesystem publication.
        runTeamImpl: async (options) => {
          const assignmentPath = path.join(workspace, 'assignments', options.childSessionId ?? 'child')
          fs.mkdirSync(assignmentPath, { recursive: true })
          const artifactPath = path.join(assignmentPath, 'extraction-report.md')
          fs.writeFileSync(artifactPath, '# Internal report')
          if (hasManual) {
            const bundle = path.join(assignmentPath, 'output/manuals/b2tjnxX8IHU/run')
            fs.mkdirSync(bundle, { recursive: true })
            fs.writeFileSync(path.join(bundle, 'manual.md'), '# Key takeaways\n\n![Training slide](frames/slide.png)')
            fs.writeFileSync(path.join(bundle, 'manual.zip'), 'portable-bundle')
          }
          return { text: 'Done', cost: 0, costTracked: true, durationMs: 1, artifactPath, assignmentPath, childSessionId: options.childSessionId ?? 'child',
            status: 'completed', succeeded: true, exitCode: 0, exitSignal: null }
        },
      })
      assert.equal(result.status, hasManual ? 'completed' : 'failed', result.summary)
      assert.equal(result.artifacts?.find((artifact) => artifact.role === 'primary')?.relativePath,
        hasManual ? 'output/manuals/b2tjnxX8IHU/run/manual.md' : undefined)
      assert.equal(result.artifacts?.some((artifact) => artifact.relativePath === 'extraction-report.md') ?? false, false)
    } finally { fs.rmSync(workspace, { recursive: true, force: true }) }
  })
})
