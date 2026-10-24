import assert from 'node:assert/strict'
import test from 'node:test'

import {
  composeYoutubeManualPlan,
  parseYoutubeManualPlan,
} from '../../domains/youtube/youtube-manual-schema.js'
import type { YoutubeVideoAnalysis } from '../../domains/youtube/youtube-manual-types.js'

const analysis: YoutubeVideoAnalysis = {
  analysisSchemaVersion: 1,
  sourceRevisionFingerprint: 'sha256:source',
  model: 'gemini-3.6-flash',
  analysisPromptVersion: 'youtube-manual-v1',
  outputLanguage: 'en',
  detectedSourceLanguage: 'en',
  generatedAt: '2026-08-12T12:00:00.000Z',
  summary: 'Create a reusable automation in two clear steps.',
  steps: [
    {
      id: 'open-editor',
      title: 'Open the editor',
      explanation: 'Open the editor and locate the workflow controls.',
      startSeconds: 10,
      endSeconds: 20,
      visualCandidates: [{
        timestampSeconds: 12,
        importance: 'required',
        reason: 'The editor controls first appear.',
        caption: 'Workflow editor controls',
        altText: 'Workflow editor with the controls panel open',
      }],
    },
    {
      id: 'save-workflow',
      title: 'Save the workflow',
      explanation: 'Review the settings and save the workflow.',
      startSeconds: 21,
      endSeconds: 35,
      visualCandidates: [{
        timestampSeconds: 30,
        importance: 'required',
        reason: 'The save action confirms the result.',
        caption: 'Save workflow action',
        altText: 'Workflow editor showing the Save workflow button',
      }],
    },
  ],
}

test('template-neutral analysis composes a validated step-by-step manual plan', () => {
  const plan = composeYoutubeManualPlan({
    analysis,
    templateId: 'step-by-step',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      channelName: 'Example Channel',
      publishedAt: '2026-08-01',
      durationSeconds: 90,
    },
  })

  assert.equal(plan.manualPlanSchemaVersion, 1)
  assert.equal(plan.templateId, 'step-by-step')
  assert.equal(plan.analysis.mode, 'gemini')
  assert.deepEqual(plan.steps.map((step) => step.order), [1, 2])
  assert.equal(plan.steps.every((step) =>
    step.visualCues.some((cue) => cue.importance === 'required')), true)
  assert.deepEqual(parseYoutubeManualPlan(plan), plan)
})

test('manual validation rejects out-of-range timestamps and generic alt text', () => {
  assert.throws(() => parseYoutubeManualPlan({
    ...composeYoutubeManualPlan({
      analysis,
      templateId: 'quick-guide',
      video: {
        videoId: 'dQw4w9WgXcQ',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Build a workflow',
        durationSeconds: 90,
      },
    }),
    steps: [{
      ...composeYoutubeManualPlan({
        analysis,
        templateId: 'quick-guide',
        video: {
          videoId: 'dQw4w9WgXcQ',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: 'Build a workflow',
          durationSeconds: 90,
        },
      }).steps[0],
      visualCues: [{
        timestampSeconds: 91,
        importance: 'required',
        reason: 'Important state.',
        caption: 'Important state',
        altText: 'image',
      }],
    }],
  }), /manual plan is invalid/i)
})

test('manual validation names the field path and rule an agent-authored plan broke', () => {
  const plan = composeYoutubeManualPlan({
    analysis,
    templateId: 'step-by-step',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 90,
    },
  })

  assert.throws(() => parseYoutubeManualPlan({
    ...plan,
    steps: [plan.steps[0], { ...plan.steps[1], order: 3 }],
  }), /steps\[1\]\.order must be 2/)
})

test('an undeclared key is reported as a schema rule without quoting the plan', () => {
  const plan = composeYoutubeManualPlan({
    analysis,
    templateId: 'step-by-step',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 90,
    },
  })

  assert.throws(
    () => parseYoutubeManualPlan({
      ...plan,
      video: { ...plan.video, sourcePath: '/Users/example/Movies/raw.mp4' },
    }),
    (error: unknown) => error instanceof Error &&
      /video has keys the plan schema does not define/.test(error.message) &&
      !error.message.includes('sourcePath'),
  )
})

test('agent-authored plans enforce the selected template cue limit per step', () => {
  const plan = composeYoutubeManualPlan({
    analysis,
    templateId: 'quick-guide',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 90,
    },
  })
  const cue = plan.steps[0]!.visualCues[0]!

  assert.throws(() => parseYoutubeManualPlan({
    ...plan,
    steps: [{ ...plan.steps[0], visualCues: [cue, { ...cue, timestampSeconds: 13 }] }],
    chapters: [{ id: 'instructions', order: 1, title: 'Instructions', stepIds: [plan.steps[0]!.id] }],
  }), /manual plan is invalid/i)
})
