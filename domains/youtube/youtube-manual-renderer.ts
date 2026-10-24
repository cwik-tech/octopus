import type { YoutubeSelectedFrame } from './youtube-frame-types.js'
import type { YoutubeManualPlan } from './youtube-manual-types.js'

export function renderYoutubeManualMarkdown(
  plan: YoutubeManualPlan,
  frames: readonly YoutubeSelectedFrame[],
): string {
  const lines: string[] = [
    `# ${escapeText(plan.video.title)}`,
    '',
    '## Source details',
    '',
    `- Author/channel: ${escapeText(plan.video.channelName ?? 'Not provided')}`,
    `- Published: ${escapeText(plan.video.publishedAt ?? 'Not provided')}`,
    `- Duration: ${formatDuration(plan.video.durationSeconds)}`,
    `- Source: [Watch on YouTube](${plan.video.url})`,
    '',
    '## Summary',
    '',
    escapeText(plan.summary),
    '',
    ...(plan.documentRequest?.purpose === 'takeaways' ? [] : [
      '## Prerequisites',
      '',
      plan.prerequisites?.length
        ? plan.prerequisites.map((prerequisite) => `- ${escapeText(prerequisite)}`).join('\n')
        : '- No prerequisites were established by the source evidence.',
      '',
    ]),
    plan.documentRequest?.purpose === 'takeaways' ? '## Key takeaways' : '## Instructions',
    '',
  ]
  for (const step of plan.steps) {
    lines.push(`### ${step.order}. ${escapeText(step.title)}`, '', escapeText(step.explanation), '')
    for (const cue of step.visualCues) {
      const frame = frames.find((candidate) =>
        candidate.stepId === step.id &&
        Math.abs(candidate.requestedTimestampSeconds - cue.timestampSeconds) < 0.001)
      if (cue.importance === 'required' && !frame) {
        throw new Error(`Required screenshot is missing for step '${step.id}'.`)
      }
      if (!frame) continue
      const seconds = Math.max(0, Math.round(cue.timestampSeconds))
      lines.push(
        `![${escapeAlt(frame.altText)}](${encodeURI(frame.relativePath)})`,
        '',
        `**${escapeText(frame.caption)}** — [${formatDuration(cue.timestampSeconds)}](${plan.video.url}&t=${seconds}s)`,
        '',
        escapeText(cue.reason),
        '',
      )
    }
  }
  lines.push(
    '## Limitations and unresolved points',
    '',
    plan.analysis.warnings.length > 0
      ? plan.analysis.warnings.map((warning) => `- ${escapeText(warning)}`).join('\n')
      : '- No unresolved points were reported by the analysis.',
    '',
    '## Generation provenance',
    '',
    `- Analysis mode: ${plan.analysis.mode}`,
    `- Model: ${escapeText(plan.analysis.model ?? 'Application fallback')}`,
    `- Generated: ${plan.analysis.generatedAt}`,
    `- Output language: ${escapeText(plan.outputLanguage)}`,
    '',
  )
  return lines.join('\n')
}

function escapeText(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>#|])/g, '\\$1').trim()
}

function escapeAlt(value: string): string {
  return value.replace(/[\]\\]/g, '\\$&').trim()
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(rounded / 3_600)
  const minutes = Math.floor((rounded % 3_600) / 60)
  const remainder = rounded % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}
