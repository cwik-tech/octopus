import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { parseToolList } from '../../core/tool-policy.js'
import { parseAgentFrontmatter } from '../../parsers/load-agent.js'

test('Web Researcher uses governed Web Research and requires exact observed source links', () => {
  const personaPath = path.join(
    process.cwd(),
    'agents',
    'web-researcher',
    'web-researcher.md',
  )
  const parsed = parseAgentFrontmatter(personaPath)

  assert.deepEqual(parseToolList(parsed.frontmatter.tools), [
    'read',
    'research_web',
    'browser',
  ])
  assert.match(parsed.body, /research_web\.search/u)
  assert.match(parsed.body, /research_web\.acquire/u)
  assert.match(parsed.body, /exact observed page URL/u)

  const skill = fs.readFileSync(
    path.join(
      process.cwd(),
      'agents',
      'web-researcher',
      'skills',
      'web-research',
      'SKILL.md',
    ),
    'utf8',
  )
  assert.match(skill, /clickable Markdown link to the exact observed page URL/u)
})

// The persona may only leave Answer mode when the task says so. A model that
// infers Handoff or EvidencePacket from context is the failure that shipped a
// deep-research packet to a human in direct chat.
test('Web Researcher defaults to Answer mode and names the other two modes explicitly', () => {
  const body = parseAgentFrontmatter(
    path.join(process.cwd(), 'agents', 'web-researcher', 'web-researcher.md'),
  ).body

  assert.match(body, /Default to Answer/u)
  assert.match(body, /Only an explicit instruction in the task moves you off Answer/u)
  assert.match(body, /templates\/research-brief\.md/u)
  assert.match(body, /EvidencePacket/u)

  const template = path.join(
    process.cwd(),
    'agents',
    'web-researcher',
    'templates',
    'research-brief.md',
  )
  assert.equal(fs.existsSync(template), true, 'Handoff mode needs its template')
})
