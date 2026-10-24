import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  resolveWorkflowArtifactText,
  resolveWorkflowStepBrief,
} from '../../workflows/handoff.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-handoff-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('resolveWorkflowStepBrief applies brief prefix, original brief, and suffix around handoff content', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'output', 'decomposition-plan.md')
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.writeFileSync(artifactPath, '# Plan\n\nBoard output body.')

    const brief = resolveWorkflowStepBrief({
      step: {
        id: 'write',
        type: 'team',
        team: 'writing-team',
        input_artifact: 'incoming-brief.md',
        result_artifact: 'final-draft.md',
        brief_prefix: 'Use the executive-summary template.',
        include_initial_brief: true,
        brief_suffix: 'Use the strategic-consulting profile.',
        handoff: {
          from_step: 'discuss',
          from_artifact: 'output/decomposition-plan.md',
          to_artifact: 'incoming-brief.md',
        },
      },
      initialBrief: 'Original user request.',
      priorResults: [
        {
          stepId: 'discuss',
          team: 'problem-thinking-board',
          status: 'completed',
          artifactPath,
          requestedResultType: 'artifact:output/decomposition-plan.md',
          assignmentPath: dir,
          childSessionId: 'child',
          summary: 'done',
          cost: 0,
        },
      ],
    })

    assert.match(brief, /Use the executive-summary template\./)
    assert.match(brief, /Board output body\./)
    assert.match(brief, /## Original Request/)
    assert.match(brief, /Original user request\./)
    assert.match(brief, /Use the strategic-consulting profile\./)
  })
})

test('resolveWorkflowStepBrief refuses a handoff artifact outside the child assignment', () => {
  withTempDir((dir) => {
    const outsidePath = path.join(path.dirname(dir), 'outside-handoff.md')
    fs.writeFileSync(outsidePath, 'outside')
    try {
      assert.throws(
        () => resolveWorkflowStepBrief({
          step: {
            id: 'write',
            type: 'team',
            team: 'writing-team',
            input_artifact: 'incoming-brief.md',
            result_artifact: 'final-draft.md',
            handoff: {
              from_step: 'discuss',
              from_artifact: '../outside-handoff.md',
              to_artifact: 'incoming-brief.md',
            },
          },
          initialBrief: 'Original request.',
          priorResults: [{
            stepId: 'discuss',
            team: 'problem-thinking-board',
            status: 'completed',
            artifactPath: outsidePath,
            requestedResultType: 'artifact:outside-handoff.md',
            assignmentPath: dir,
            childSessionId: 'child',
            summary: 'done',
            cost: 0,
          }],
        }),
        /escapes its assignment directory/,
      )
    } finally {
      fs.rmSync(outsidePath, { force: true })
    }
  })
})

test('resolveWorkflowArtifactText securely reads an owned provenance artifact', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'research-package.md')
    fs.writeFileSync(artifactPath, [
      '---',
      'artifact_type: report',
      '---',
      '# Research package',
      '',
      'Evidence body.',
    ].join('\n'))

    const text = resolveWorkflowArtifactText({
      consumerStepId: 'publish',
      source: {
        from_step: 'research',
        from_artifact: 'research-package.md',
      },
      priorResults: [{
        stepId: 'research',
        team: 'research-team',
        status: 'completed',
        artifactPath,
        requestedResultType: 'artifact:research-package.md',
        assignmentPath: dir,
        childSessionId: 'research-child',
        summary: 'done',
        cost: 0,
      }],
      purpose: 'provenance handoff',
    })

    assert.equal(text, '# Research package\n\nEvidence body.')
  })
})

test('resolveWorkflowArtifactText refuses a provenance symlink outside the assignment', () => {
  withTempDir((dir) => {
    const outsidePath = path.join(path.dirname(dir), `outside-provenance-${process.pid}.md`)
    const symlinkPath = path.join(dir, 'research-package.md')
    fs.writeFileSync(outsidePath, '# Outside')
    fs.symlinkSync(outsidePath, symlinkPath)
    try {
      assert.throws(
        () => resolveWorkflowArtifactText({
          consumerStepId: 'publish',
          source: {
            from_step: 'research',
            from_artifact: 'research-package.md',
          },
          priorResults: [{
            stepId: 'research',
            team: 'research-team',
            status: 'completed',
            artifactPath: symlinkPath,
            requestedResultType: 'artifact:research-package.md',
            assignmentPath: dir,
            childSessionId: 'research-child',
            summary: 'done',
            cost: 0,
          }],
          purpose: 'provenance handoff',
        }),
        /provenance handoff failed.*resolves outside its assignment directory/,
      )
    } finally {
      fs.rmSync(outsidePath, { force: true })
    }
  })
})
