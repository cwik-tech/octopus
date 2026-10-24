import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseAgentFrontmatter } from '../../parsers/load-agent.js'
import { parseBrowserDomains, type BrowserAgentPolicy } from '../browser/browser-policy.js'
import { parseToolList } from '../../core/tool-policy.js'

export function readAcquisitionAgentPolicy(
  repoRootPath: string,
  agentPath: string,
): BrowserAgentPolicy {
  const match = agentPath.trim().match(/^agents\/([a-z0-9][a-z0-9-]{0,127})$/u)
  const agentName = match?.[1]
  if (!agentName) return disabled()
  const personaPath = path.join(repoRootPath, 'agents', agentName, `${agentName}.md`)
  if (!fs.existsSync(personaPath)) return disabled()
  try {
    const frontmatter = parseAgentFrontmatter(personaPath).frontmatter
    return {
      enabled: parseToolList(frontmatter.tools)?.includes('research_web') ?? false,
      restrictDomains:
        String(frontmatter.browser_restrict_domains ?? '').trim().toLowerCase() === 'true',
      domains: parseBrowserDomains(frontmatter.browser_domains),
    }
  } catch {
    return disabled()
  }
}

function disabled(): BrowserAgentPolicy {
  return { enabled: false, restrictDomains: false, domains: [] }
}
