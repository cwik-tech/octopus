import { describe, it, expect } from 'vitest'
import { getRenderer } from '../index'
import { DefaultRenderer } from '../default'
import { DiscussionRenderer } from '../discussion'
import { PipelineRenderer } from '../pipeline'

describe('getRenderer', () => {
  it('returns DiscussionRenderer for "discussion"', () => {
    expect(getRenderer('discussion')).toBe(DiscussionRenderer)
  })

  it('returns PipelineRenderer for "pipeline"', () => {
    expect(getRenderer('pipeline')).toBe(PipelineRenderer)
  })

  it('returns DefaultRenderer for "default"', () => {
    expect(getRenderer('default')).toBe(DefaultRenderer)
  })

  it('returns DefaultRenderer for unknown stage type', () => {
    expect(getRenderer('unknown')).toBe(DefaultRenderer)
  })

  it('returns DefaultRenderer for empty string', () => {
    expect(getRenderer('')).toBe(DefaultRenderer)
  })

  it('returns DefaultRenderer for a random future stage type', () => {
    expect(getRenderer('brainstorm')).toBe(DefaultRenderer)
  })

  it('is case-sensitive — "Discussion" does not match "discussion"', () => {
    expect(getRenderer('Discussion')).toBe(DefaultRenderer)
  })

  it('invariant: always returns a function (React component)', () => {
    for (const type of ['discussion', 'pipeline', 'default', 'unknown', '', 'PIPELINE']) {
      expect(typeof getRenderer(type)).toBe('function')
    }
  })
})
