/**
 * The level an Architect's own agent file asks for, as the Architect runs it.
 *
 * Both Architects are Agents, and both are editable through the ordinary Agent
 * editor. So the vocabulary the editor offers and the vocabulary these loaders
 * accept have to be the same one. Where they are not, the editor shows a level,
 * the file stores it, and the turn runs at a depth nobody chose — the failure
 * is invisible at every step, which is what makes it worth a test of its own.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { loadArchitectConfig } from '../../domains/provider/architect-model-config.js'
import { loadResourceArchitectConfig } from '../../domains/resource-architect/resource-architect-prompt.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'

function withArchitectRoot(
  teamName: string,
  frontmatter: string,
  run: (root: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-effort-'))
  try {
    const teamDir = path.join(root, 'teams', teamName)
    const agentDir = path.join(teamDir, 'agents', 'architect')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(teamDir, 'team.yaml'),
      [
        'team:',
        `  name: ${teamName}`,
        'agents:',
        '  - name: architect',
        '    agent_file: agents/architect/architect.md',
        '',
      ].join('\n'),
    )
    fs.writeFileSync(
      path.join(agentDir, 'architect.md'),
      `---\nname: architect\nprovider: openrouter\nmodel: vendor/model\n${frontmatter}\n---\n\n# Architect\n\nBody.\n`,
    )
    setRuntimeDefaultModelState({
      status: 'available',
      provider: 'connection:abc',
      model: 'vendor/model',
    })
    try {
      run(root)
    } finally {
      setRuntimeDefaultModelState({ status: 'unset' })
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('the Workflow Architect runs at the level its own file names', () => {
  withArchitectRoot('workflow-architect', 'thinking: xhigh', (root) => {
    assert.equal(loadArchitectConfig(root).thinking, 'xhigh')
  })
})

test('the Workflow Architect still runs at medium when its file names nothing', () => {
  withArchitectRoot('workflow-architect', 'description: no level here', (root) => {
    assert.equal(loadArchitectConfig(root).thinking, 'medium')
  })
})

test('the Resource Architect runs at the level its own file names', () => {
  withArchitectRoot('resource-architect', 'thinking: max', (root) => {
    assert.equal(loadResourceArchitectConfig(root).thinking, 'max')
  })
})

test('the Resource Architect still runs at medium when its file names nothing', () => {
  withArchitectRoot('resource-architect', 'description: no level here', (root) => {
    assert.equal(loadResourceArchitectConfig(root).thinking, 'medium')
  })
})
