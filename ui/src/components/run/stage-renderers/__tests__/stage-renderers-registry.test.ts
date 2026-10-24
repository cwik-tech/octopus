import { describe, it, expect } from 'vitest'
import { getRenderer } from '../index'
import { DefaultRenderer } from '../default'
import { DiscussionRenderer } from '../discussion'
import { PipelineRenderer } from '../pipeline'

describe('stage-renderers registry', () => {
  it('returns DefaultRenderer for unknown stageType', () => {
    expect(getRenderer('unknown-type')).toBe(DefaultRenderer)
  })

  it('returns DefaultRenderer for "default"', () => {
    expect(getRenderer('default')).toBe(DefaultRenderer)
  })

  it('returns DiscussionRenderer for "discussion"', () => {
    expect(getRenderer('discussion')).toBe(DiscussionRenderer)
  })

  it('returns PipelineRenderer for "pipeline"', () => {
    expect(getRenderer('pipeline')).toBe(PipelineRenderer)
  })

  it('falls back to DefaultRenderer for empty string', () => {
    expect(getRenderer('')).toBe(DefaultRenderer)
  })
})
