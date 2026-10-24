import type { YoutubeManualTemplateId } from '../youtube-manual-types.js'

export interface YoutubeManualTemplate {
  readonly id: YoutubeManualTemplateId
  readonly displayName: string
  readonly maximumFrames: number
  readonly maximumCuesPerStep: number
  readonly supportingIntervalSeconds?: number
}

export const YOUTUBE_MANUAL_TEMPLATES: Readonly<Record<YoutubeManualTemplateId, YoutubeManualTemplate>> = {
  'quick-guide': {
    id: 'quick-guide',
    displayName: 'Quick guide',
    maximumFrames: 15,
    maximumCuesPerStep: 1,
  },
  'step-by-step': {
    id: 'step-by-step',
    displayName: 'Step by step',
    maximumFrames: 50,
    maximumCuesPerStep: 2,
  },
  'dense-visual': {
    id: 'dense-visual',
    displayName: 'Dense visual',
    maximumFrames: 150,
    maximumCuesPerStep: 150,
    supportingIntervalSeconds: 5,
  },
}

export const DEFAULT_YOUTUBE_MANUAL_TEMPLATE_ID: YoutubeManualTemplateId = 'step-by-step'
