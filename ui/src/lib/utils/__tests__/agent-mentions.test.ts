import { describe, expect, it } from 'vitest'

import type { AgentSummary } from '@/lib/models/agent-generator-model'
import {
  findActiveAgentMention,
  insertAgentMention,
  resolveAgentMentions,
} from '@/lib/utils/agent-mentions'

const AGENTS: AgentSummary[] = [
  { name: 'analyst', skills: [], usedInTeams: [] },
  { name: 'writer', skills: [], usedInTeams: [] },
  { name: 'domain-researcher', skills: [], usedInTeams: [] },
]

describe('agent mentions', () => {
  it('finds the mention query at the cursor without treating email addresses as mentions', () => {
    expect(findActiveAgentMention('Ask @dom', 8)).toEqual({
      start: 4,
      end: 8,
      query: 'dom',
    })
    expect(findActiveAgentMention('mail user@example.com', 17)).toBeNull()
  })

  it('requires an alphanumeric first character for active mention tokens', () => {
    expect(findActiveAgentMention('@_writer', 8)).toBeNull()
    expect(findActiveAgentMention('@-writer', 8)).toBeNull()
  })

  it('handles cursor boundaries and extends the active range past the cursor', () => {
    expect(findActiveAgentMention('@writer', 0)).toBeNull()
    expect(findActiveAgentMention('@writer', 1)).toEqual({
      start: 0,
      end: 7,
      query: '',
    })
    expect(findActiveAgentMention('@writer', 4)).toEqual({
      start: 0,
      end: 7,
      query: 'wri',
    })
  })

  it('replaces the complete active token with the stable agent id', () => {
    expect(
      insertAgentMention('Ask @dom-rese later', { start: 4, end: 13, query: 'dom-rese' }, 'domain-researcher'),
    ).toEqual({
      text: 'Ask @domain-researcher later',
      cursor: 22,
    })
  })

  it('adds a trailing space and advances the cursor when inserting at the end', () => {
    expect(
      insertAgentMention('Ask @wri', { start: 4, end: 8, query: 'wri' }, 'writer'),
    ).toEqual({
      text: 'Ask @writer ',
      cursor: 12,
    })
  })

  it('resolves exact valid mentions once in first-appearance order', () => {
    expect(
      resolveAgentMentions(
        'Ask @writer, then @analyst and @writer. Ignore @unknown.',
        AGENTS,
      ),
    ).toEqual({
      agentNames: ['writer', 'analyst'],
      overflow: false,
    })
  })

  it('does not resolve embedded or prefix-only names', () => {
    expect(
      resolveAgentMentions(
        'Email writer@example.com; do not route @write or x@analyst.',
        AGENTS,
      ),
    ).toEqual({ agentNames: [], overflow: false })
  })

  it('reports overflow instead of silently routing only some agents', () => {
    const agents = Array.from({ length: 9 }, (_, index) => ({
      name: `agent-${index + 1}`,
      skills: [],
      usedInTeams: [],
    }))
    expect(
      resolveAgentMentions(
        agents.map((agent) => `@${agent.name}`).join(' '),
        agents,
      ),
    ).toEqual({
      agentNames: agents.map((agent) => agent.name),
      overflow: true,
    })
  })

  it('accepts exactly eight unique agent mentions', () => {
    const agents = Array.from({ length: 8 }, (_, index) => ({
      name: `agent-${index + 1}`,
      skills: [],
      usedInTeams: [],
    }))
    expect(
      resolveAgentMentions(
        agents.map((agent) => `@${agent.name}`).join(' '),
        agents,
      ),
    ).toEqual({
      agentNames: agents.map((agent) => agent.name),
      overflow: false,
    })
  })
})
