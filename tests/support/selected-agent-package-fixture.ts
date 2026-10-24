/**
 * A saved Agent package with one unique marker per file, for tests that prove
 * the Agent open in the Create inspector reaches the Agent Architect whole.
 *
 * Every marker exists only in the file that carries it, so a request that
 * contains the marker has read that file and nothing else could have put it
 * there.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const SELECTED_AGENT = 'researcher'
export const OTHER_AGENT = 'other-agent'
export const SELECTED_TEAM = 'research-team'

export const SELECTED_PACKAGE_MARKERS = {
  runOrder: [
    'RUN-ORDER-FIRST-CONFIRM-SCOPE-4K1',
    'RUN-ORDER-SECOND-GATHER-EVIDENCE-8T2',
    'RUN-ORDER-THIRD-WRITE-VERDICT-3N7',
  ],
  skill: 'SKILL-BODY-DESK-RESEARCH-6H4',
  template: 'TEMPLATE-BRIEF-9P2',
  reference: 'REFERENCE-STANDARDS-2X8',
  script: 'SCRIPT-COLLECT-5V3',
  knowledge: 'KNOWLEDGE-NOTES-7C1',
  experience: 'EXPERIENCE-LESSONS-1B9',
  other: 'OTHER-STYLE-GUIDE-4Q6',
} as const

export const OTHER_AGENT_MARKERS = {
  persona: 'OTHER-AGENT-PERSONA-BODY-3J5',
  skill: 'OTHER-AGENT-SKILL-BODY-8L2',
} as const

export const SELECTED_BROWSER_DOMAIN = 'evidence.example.org'

/** Bytes that are not text: a PNG signature with an embedded NUL. */
export const BINARY_ASSET_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])

export function selectedAgentPersona(runOrder: readonly string[] = SELECTED_PACKAGE_MARKERS.runOrder): string {
  return [
    '---',
    `name: ${SELECTED_AGENT}`,
    'description: Finds evidence.',
    'provider: openai',
    'model: gpt-5.4',
    'thinking: medium',
    'tools: research_web, generate_word',
    'browser_restrict_domains: true',
    `browser_domains: ${SELECTED_BROWSER_DOMAIN}`,
    '---',
    '',
    `# ${SELECTED_AGENT}`,
    '',
    '## Run order',
    '',
    ...runOrder.map((step, index) => `${index + 1}. ${step}`),
    '',
  ].join('\n')
}

export function writeSelectedAgentPackage(repoRoot: string): void {
  const files: Record<string, string | Buffer> = {
    [`agents/${SELECTED_AGENT}/${SELECTED_AGENT}.md`]: selectedAgentPersona(),
    [`agents/${SELECTED_AGENT}/skills/desk-research/SKILL.md`]: [
      '---',
      'name: desk-research',
      'description: >',
      '  Find credible references for a claim. Use when a claim needs a source.',
      '---',
      '',
      '# Desk Research',
      '',
      `Procedure: ${SELECTED_PACKAGE_MARKERS.skill}.`,
      '',
    ].join('\n'),
    [`agents/${SELECTED_AGENT}/skills/desk-research/templates/brief.md`]:
      `# Brief\n\n${SELECTED_PACKAGE_MARKERS.template}\n`,
    [`agents/${SELECTED_AGENT}/skills/desk-research/references/standards.md`]:
      `# Standards\n\n${SELECTED_PACKAGE_MARKERS.reference}\n`,
    [`agents/${SELECTED_AGENT}/scripts/collect.js`]:
      `export const marker = '${SELECTED_PACKAGE_MARKERS.script}'\n`,
    [`agents/${SELECTED_AGENT}/knowledge/notes.md`]:
      `# Notes\n\n${SELECTED_PACKAGE_MARKERS.knowledge}\n`,
    [`agents/${SELECTED_AGENT}/experience/lessons.md`]:
      `# Lessons\n\n${SELECTED_PACKAGE_MARKERS.experience}\n`,
    [`agents/${SELECTED_AGENT}/assets/style-guide.md`]:
      `# Style\n\n${SELECTED_PACKAGE_MARKERS.other}\n`,
    [`agents/${SELECTED_AGENT}/assets/logo.png`]: BINARY_ASSET_BYTES,
    [`agents/${OTHER_AGENT}/${OTHER_AGENT}.md`]: [
      '---',
      `name: ${OTHER_AGENT}`,
      'description: Checks citations.',
      'provider: openai',
      'model: gpt-5.4',
      '---',
      '',
      `# ${OTHER_AGENT}`,
      '',
      OTHER_AGENT_MARKERS.persona,
      '',
    ].join('\n'),
    [`agents/${OTHER_AGENT}/skills/citation-check/SKILL.md`]: [
      '---',
      'name: citation-check',
      'description: Check a citation. Use when a draft cites a source.',
      '---',
      '',
      OTHER_AGENT_MARKERS.skill,
      '',
    ].join('\n'),
    'teams.yaml': [
      `${SELECTED_TEAM}:`,
      '  type: team',
      '  description: Researches claims.',
      `  team_path: ./teams/${SELECTED_TEAM}`,
      '',
    ].join('\n'),
    [`teams/${SELECTED_TEAM}/team.yaml`]: [
      'team:',
      `  name: ${SELECTED_TEAM}`,
      'agents:',
      `  - name: ${SELECTED_AGENT}`,
      `    agent_file: ../../agents/${SELECTED_AGENT}/${SELECTED_AGENT}.md`,
      '',
    ].join('\n'),
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoRoot, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  }
}

/** The one package block a request carries for `agentName`, or null. */
export function selectedPackageBlock(text: string, agentName = SELECTED_AGENT): string | null {
  const opening = `<selected_agent_package agent="${agentName}">`
  const start = text.indexOf(opening)
  if (start === -1) return null
  const end = text.indexOf('</selected_agent_package>', start)
  return end === -1 ? null : text.slice(start, end + '</selected_agent_package>'.length)
}
