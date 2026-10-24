import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseAgentFrontmatter } from '../../parsers/load-agent.js'
import { parseToolList } from '../../core/tool-policy.js'
import { GENERATE_WORD_TOOL_NAME } from './generate-word-types.js'

export function isGenerateWordEnabledForAgent(
  repoRootPath: string,
  agentPath: string,
): boolean {
  const match = agentPath.trim().match(
    /^agents\/([a-z0-9][a-z0-9-]{0,127})$/,
  )
  const agentName = match?.[1]
  if (agentName === undefined) return false
  const personaPath = path.join(
    repoRootPath,
    'agents',
    agentName,
    `${agentName}.md`,
  )
  if (!fs.existsSync(personaPath)) return false
  try {
    const frontmatter = parseAgentFrontmatter(personaPath).frontmatter
    return (
      parseToolList(frontmatter.tools)?.includes(GENERATE_WORD_TOOL_NAME) ??
      false
    )
  } catch {
    return false
  }
}
