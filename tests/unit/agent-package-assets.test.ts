import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  addAgentPackageFiles,
  commitAgentPackageImport,
  previewAgentPackageImport,
  removeAgentPackageItem,
} from '../../domains/agent-generator/index.js'

function withTempRepo(fn: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-assets-'))
  const agentDir = path.join(repoRoot, 'agents', 'alpha')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'alpha.md'), '# Alpha\n')
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })
}

function file(relativePath: string, body: string) {
  return {
    relativePath,
    contentBase64: Buffer.from(body).toString('base64'),
  }
}

test('addAgentPackageFiles imports a selected skill folder', async () => {
  await withTempRepo(async (repoRoot) => {
    const detail = await addAgentPackageFiles({
      repoRoot,
      agentName: 'alpha',
      kind: 'skill',
      files: [
        file('market-research/SKILL.md', '---\ndescription: Research markets.\n---\n'),
        file('market-research/references/source.md', '# Source\n'),
      ],
    })

    assert.deepEqual(detail.skills, ['market-research'])
    assert.equal(
      fs.existsSync(
        path.join(repoRoot, 'agents', 'alpha', 'skills', 'market-research', 'SKILL.md'),
      ),
      true,
    )
    assert.equal(detail.counts.references, 1)
  })
})

test('addAgentPackageFiles adds top-level package assets and suffixes duplicates', async () => {
  await withTempRepo(async (repoRoot) => {
    await addAgentPackageFiles({
      repoRoot,
      agentName: 'alpha',
      kind: 'reference',
      files: [file('brief.md', '# One\n')],
    })
    const detail = await addAgentPackageFiles({
      repoRoot,
      agentName: 'alpha',
      kind: 'reference',
      files: [file('brief.md', '# Two\n')],
    })

    assert.equal(detail.counts.references, 2)
    assert.equal(
      fs.readFileSync(path.join(repoRoot, 'agents', 'alpha', 'references', 'brief.md'), 'utf8'),
      '# One\n',
    )
    assert.equal(
      fs.readFileSync(path.join(repoRoot, 'agents', 'alpha', 'references', 'brief-2.md'), 'utf8'),
      '# Two\n',
    )
  })
})

test('removeAgentPackageItem deletes files and skill folders', async () => {
  await withTempRepo(async (repoRoot) => {
    await addAgentPackageFiles({
      repoRoot,
      agentName: 'alpha',
      kind: 'reference',
      files: [file('brief.md', '# Brief\n')],
    })
    await addAgentPackageFiles({
      repoRoot,
      agentName: 'alpha',
      kind: 'skill',
      files: [file('market-research/SKILL.md', '# Skill\n')],
    })

    let detail = await removeAgentPackageItem({
      repoRoot,
      agentName: 'alpha',
      kind: 'reference',
      agentPath: 'references/brief.md',
    })
    assert.equal(detail.counts.references, 0)
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'agents', 'alpha', 'references', 'brief.md')),
      false,
    )

    detail = await removeAgentPackageItem({
      repoRoot,
      agentName: 'alpha',
      kind: 'skill',
      agentPath: 'market-research',
    })
    assert.deepEqual(detail.skills, [])
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'agents', 'alpha', 'skills', 'market-research')),
      false,
    )
  })
})

test('previewAgentPackageImport detects bundled skill assets and conflicts', async () => {
  await withTempRepo(async (repoRoot) => {
    await addAgentPackageFiles({
      repoRoot,
      agentName: 'alpha',
      kind: 'reference',
      files: [file('source.md', '# Existing\n')],
    })

    const preview = previewAgentPackageImport({
      repoRoot,
      agentName: 'alpha',
      preferredKind: 'skill',
      files: [
        file('market-research/SKILL.md', '# Skill\n'),
        file('market-research/references/source.md', '# Source\n'),
        file('market-research/templates/output.md', '# Output\n'),
      ],
    })

    assert.deepEqual(
      preview.items
        .map((item) => [item.kind, item.targetAgentPath, item.exists])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      [
        ['reference', 'skills/market-research/references/source.md', false],
        ['skill', 'skills/market-research/SKILL.md', false],
        ['template', 'skills/market-research/templates/output.md', false],
      ],
    )

    const referencePreview = previewAgentPackageImport({
      repoRoot,
      agentName: 'alpha',
      preferredKind: 'reference',
      files: [file('source.md', '# Replacement\n')],
    })
    assert.equal(requiredValue(referencePreview.items[0], 'tests/unit/agent-package-assets.test.ts:159').exists, true)
    assert.equal(requiredValue(referencePreview.items[0], 'tests/unit/agent-package-assets.test.ts:160').defaultSelected, false)
    assert.deepEqual(requiredValue(referencePreview.items[0], 'tests/unit/agent-package-assets.test.ts:161').availableActions, [
      'skip',
      'replace',
      'keepBoth',
    ])
  })
})

test('previewAgentPackageImport marks plain requested-kind files as selected adds', async () => {
  await withTempRepo(async (repoRoot) => {
    const preview = previewAgentPackageImport({
      repoRoot,
      agentName: 'alpha',
      preferredKind: 'reference',
      files: [file('consolidation-prompt.md', '# Prompt\n')],
    })

    assert.equal(preview.items.length, 1)
    assert.equal(requiredValue(preview.items[0], 'tests/unit/agent-package-assets.test.ts:179').kind, 'reference')
    assert.equal(requiredValue(preview.items[0], 'tests/unit/agent-package-assets.test.ts:180').targetAgentPath, 'references/consolidation-prompt.md')
    assert.equal(requiredValue(preview.items[0], 'tests/unit/agent-package-assets.test.ts:181').exists, false)
    assert.equal(requiredValue(preview.items[0], 'tests/unit/agent-package-assets.test.ts:182').defaultSelected, true)
    assert.equal(requiredValue(preview.items[0], 'tests/unit/agent-package-assets.test.ts:183').defaultAction, 'add')
  })
})

test('previewAgentPackageImport exposes extra files selected from a package folder', async () => {
  await withTempRepo(async (repoRoot) => {
    const preview = previewAgentPackageImport({
      repoRoot,
      agentName: 'alpha',
      preferredKind: 'reference',
      files: [
        file('package/references/consolidation-prompt.md', '# Prompt\n'),
        file('package/templates/output.md', '# Output\n'),
      ],
    })

    assert.deepEqual(
      preview.items
        .map((item) => [item.kind, item.targetAgentPath, item.defaultSelected])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      [
        ['reference', 'references/consolidation-prompt.md', true],
        ['template', 'templates/output.md', false],
      ],
    )
  })
})

test('commitAgentPackageImport applies selected choices', async () => {
  await withTempRepo(async (repoRoot) => {
    const files = [
      file('market-research/SKILL.md', '# Skill\n'),
      file('market-research/references/source.md', '# Source\n'),
      file('market-research/scripts/run.mjs', 'console.log("run")\n'),
    ]
    const preview = previewAgentPackageImport({
      repoRoot,
      agentName: 'alpha',
      preferredKind: 'skill',
      files,
    })
    const detail = await commitAgentPackageImport({
      repoRoot,
      agentName: 'alpha',
      preferredKind: 'skill',
      files,
      choices: preview.items.map((item) => ({
        id: item.id,
        selected: item.kind !== 'script',
        action: item.defaultAction,
      })),
    })

    assert.deepEqual(detail.skills, ['market-research'])
    assert.equal(detail.counts.references, 1)
    assert.equal(detail.counts.scripts, 0)
    assert.equal(
      fs.existsSync(
        path.join(repoRoot, 'agents', 'alpha', 'skills', 'market-research', 'scripts', 'run.mjs'),
      ),
      false,
    )
  })
})

test('disconnecting a skill preserves a shared library copy before removing it from the agent', async () => {
  await withTempRepo(async (repoRoot) => {
    await addAgentPackageFiles({
      repoRoot,
      agentName: 'alpha',
      kind: 'skill',
      files: [file('market-research/SKILL.md', '# Skill\n')],
    })

    const detail = await removeAgentPackageItem({
      repoRoot,
      agentName: 'alpha',
      kind: 'skill',
      agentPath: 'market-research',
      mode: 'disconnect',
    })

    assert.deepEqual(detail.skills, [])
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'agents', 'alpha', 'skills', 'market-research')),
      false,
    )
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'skills', 'market-research', 'SKILL.md')),
      true,
    )
  })
})

test('disconnecting a colliding skill preserves both exact variants', async () => {
  await withTempRepo(async (repoRoot) => {
    const sharedDir = path.join(repoRoot, 'skills', 'market-research')
    fs.mkdirSync(path.join(sharedDir, 'references'), { recursive: true })
    fs.writeFileSync(path.join(sharedDir, 'SKILL.md'), '# Shared instructions\n')
    fs.writeFileSync(path.join(sharedDir, 'references', 'source.md'), '# Shared source\n')
    await addAgentPackageFiles({
      repoRoot,
      agentName: 'alpha',
      kind: 'skill',
      files: [
        file('market-research/SKILL.md', '# Agent instructions\n'),
        file('market-research/references/source.md', '# Agent source\n'),
      ],
    })

    await removeAgentPackageItem({
      repoRoot,
      agentName: 'alpha',
      kind: 'skill',
      agentPath: 'market-research',
      mode: 'disconnect',
    })

    assert.equal(fs.readFileSync(path.join(sharedDir, 'SKILL.md'), 'utf8'), '# Shared instructions\n')
    assert.equal(
      fs.readFileSync(path.join(sharedDir, 'references', 'source.md'), 'utf8'),
      '# Shared source\n',
    )
    const variantContainers = fs.readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('market-research-'))
    assert.equal(variantContainers.length, 1)
    const variantDir = path.join(
      repoRoot,
      'skills',
      variantContainers[0]?.name ?? 'missing-variant',
      'market-research',
    )
    assert.equal(fs.readFileSync(path.join(variantDir, 'SKILL.md'), 'utf8'), '# Agent instructions\n')
    assert.equal(
      fs.readFileSync(path.join(variantDir, 'references', 'source.md'), 'utf8'),
      '# Agent source\n',
    )
  })
})
