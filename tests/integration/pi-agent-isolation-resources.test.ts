/**
 * What Pi itself still finds after the agent directory is isolated.
 *
 * Reading the files back with `fs` proves they were placed; it does not prove
 * Pi consumes them. These load the installed `DefaultResourceLoader` and
 * `ProjectTrustStore` against the isolated directory and ask them what they
 * found, which is the same code the Team host runs.
 *
 * Entirely local: no CLI, no provider, no network. The loader reads files and
 * reports what it read.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  DefaultResourceLoader,
  ProjectTrustStore,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

import { isolatePiAgentDirectory } from '../../domains/run/pi-agent-isolation.js'

/** A user's agent directory with one of everything that matters. */
function sharedAgentDirectory(): string {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-agent-'))
  fs.writeFileSync(path.join(shared, 'settings.json'), '{}')
  fs.writeFileSync(path.join(shared, 'auth.json'), '{}', { mode: 0o600 })
  fs.writeFileSync(path.join(shared, 'AGENTS.md'), '# the user global context')
  fs.writeFileSync(path.join(shared, 'SYSTEM.md'), 'the user system prompt')
  fs.writeFileSync(path.join(shared, 'APPEND_SYSTEM.md'), 'the user appended prompt')

  fs.mkdirSync(path.join(shared, 'skills', 'a-user-skill'), { recursive: true })
  fs.writeFileSync(
    path.join(shared, 'skills', 'a-user-skill', 'SKILL.md'),
    '---\nname: a-user-skill\ndescription: Something the user installed.\n---\n\nBody.\n',
  )
  fs.mkdirSync(path.join(shared, 'npm'), { recursive: true })
  fs.writeFileSync(path.join(shared, 'npm', 'marker.txt'), 'installed packages live here')
  return shared
}

async function loadFrom(agentDir: string, cwd: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
  })
  await loader.reload()
  return loader
}

test('Pi still finds the user resources after isolation', async () => {
  const shared = sharedAgentDirectory()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'))
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    const before = await loadFrom(shared, cwd)
    const after = await loadFrom(isolated.path, cwd)

    assert.equal(
      after.getSystemPrompt(),
      before.getSystemPrompt(),
      'the global SYSTEM.md must still reach the run',
    )
    assert.deepEqual(
      after.getAppendSystemPrompt(),
      before.getAppendSystemPrompt(),
      'the global APPEND_SYSTEM.md must still reach the run',
    )
    assert.deepEqual(
      after.getAgentsFiles().agentsFiles.map((file) => file.content),
      before.getAgentsFiles().agentsFiles.map((file) => file.content),
      'the global context file must still reach the run',
    )
    assert.deepEqual(
      after.getSkills().skills.map((skill) => skill.name).sort(),
      before.getSkills().skills.map((skill) => skill.name).sort(),
      'the skills the user installed must still be found',
    )
    // Not empty, or the comparison above would pass on two empty sets.
    assert.ok(
      before.getSkills().skills.some((skill) => skill.name === 'a-user-skill'),
      'precondition: the user has a skill to lose',
    )
    assert.ok(before.getSystemPrompt(), 'precondition: the user has a system prompt to lose')
  } finally {
    isolated.dispose()
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a project the user already trusted is still trusted', () => {
  const shared = sharedAgentDirectory()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'))
  // Recorded through the installed store, so the file is whatever Pi writes.
  new ProjectTrustStore(shared).set(cwd, true)

  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    assert.equal(
      new ProjectTrustStore(shared).get(cwd),
      true,
      'precondition: the user trusted this project',
    )
    assert.equal(
      new ProjectTrustStore(isolated.path).get(cwd),
      true,
      'a run must not find a trusted project untrusted and skip its resources',
    )
  } finally {
    isolated.dispose()
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a trust decision inside the run does not reach the user', () => {
  const shared = sharedAgentDirectory()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'))
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-project-'))
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    new ProjectTrustStore(isolated.path).set(other, true)

    assert.notEqual(
      new ProjectTrustStore(shared).get(other),
      true,
      "a run must not record trust decisions in the user's own store",
    )
  } finally {
    isolated.dispose()
    fs.rmSync(other, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('the directory settings-declared packages install into is still there', () => {
  const shared = sharedAgentDirectory()
  const isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
  try {
    // `dist/core/package-manager.js:1677-1679`. Without it a settings file that
    // names packages would find none installed and could reinstall them.
    assert.equal(
      fs.readFileSync(path.join(isolated.path, 'npm', 'marker.txt'), 'utf8'),
      'installed packages live here',
    )
  } finally {
    isolated.dispose()
    fs.rmSync(shared, { recursive: true, force: true })
  }
})
