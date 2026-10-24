import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  findSharedContentDrift,
  parseSharedContentManifest,
  syncSharedContent,
  type SharedContentManifest,
} from '../../scripts/agent-shared-content.js'

const MANIFEST: SharedContentManifest = {
  groups: [
    {
      id: 'review-checklist',
      canonical: 'agents/lead/skills/review-checklist',
      copies: ['agents/helper/skills/review-checklist', 'agents/second/skills/review-checklist'],
    },
  ],
  forks: [
    {
      path: 'agents/variant/skills/review-checklist',
      of: 'review-checklist',
      reason: 'Keeps an extra rule on purpose.',
    },
  ],
}

function writeTree(root: string, directory: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, directory, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

function readTree(root: string, directory: string): Record<string, string> {
  const tree: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) walk(entryPath)
      else tree[path.relative(path.join(root, directory), entryPath)] = fs.readFileSync(entryPath, 'utf8')
    }
  }
  walk(path.join(root, directory))
  return tree
}

const CANONICAL_FILES = {
  'SKILL.md': '# Review checklist\n\nSee `references/rules.md`.\n',
  'references/rules.md': 'Rule one.\n',
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shared-content-'))
  writeTree(root, 'agents/lead/skills/review-checklist', CANONICAL_FILES)
  writeTree(root, 'agents/helper/skills/review-checklist', CANONICAL_FILES)
  writeTree(root, 'agents/second/skills/review-checklist', CANONICAL_FILES)
  writeTree(root, 'agents/variant/skills/review-checklist', { ...CANONICAL_FILES, 'SKILL.md': '# Review checklist\n\nExtra rule.\n' })
  return root
}

test('copies identical to their canonical source report no drift', () => {
  const root = fixture()
  try {
    assert.deepEqual(findSharedContentDrift(root, MANIFEST), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a changed, a missing and an extra file in a copy are each reported', () => {
  const root = fixture()
  try {
    fs.writeFileSync(path.join(root, 'agents/helper/skills/review-checklist/SKILL.md'), '# Edited\n')
    fs.rmSync(path.join(root, 'agents/second/skills/review-checklist/references/rules.md'))
    fs.writeFileSync(path.join(root, 'agents/second/skills/review-checklist/notes.md'), 'Local note.\n')

    assert.deepEqual(findSharedContentDrift(root, MANIFEST), [
      { group: 'review-checklist', copy: 'agents/helper/skills/review-checklist', file: 'SKILL.md', kind: 'changed' },
      { group: 'review-checklist', copy: 'agents/second/skills/review-checklist', file: 'notes.md', kind: 'extra' },
      { group: 'review-checklist', copy: 'agents/second/skills/review-checklist', file: 'references/rules.md', kind: 'missing' },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('syncing makes every copy match its canonical source and leaves the canonical and forks alone', () => {
  const root = fixture()
  try {
    fs.writeFileSync(path.join(root, 'agents/helper/skills/review-checklist/SKILL.md'), '# Edited\n')
    fs.rmSync(path.join(root, 'agents/second/skills/review-checklist/references/rules.md'))
    fs.writeFileSync(path.join(root, 'agents/second/skills/review-checklist/notes.md'), 'Local note.\n')
    const forkBefore = readTree(root, 'agents/variant/skills/review-checklist')

    const written = syncSharedContent(root, MANIFEST)

    assert.deepEqual(written, ['agents/helper/skills/review-checklist', 'agents/second/skills/review-checklist'])
    assert.deepEqual(readTree(root, 'agents/helper/skills/review-checklist'), CANONICAL_FILES)
    assert.deepEqual(readTree(root, 'agents/second/skills/review-checklist'), CANONICAL_FILES)
    assert.deepEqual(readTree(root, 'agents/lead/skills/review-checklist'), CANONICAL_FILES)
    assert.deepEqual(readTree(root, 'agents/variant/skills/review-checklist'), forkBefore)
    assert.deepEqual(findSharedContentDrift(root, MANIFEST), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a manifest path that could reach outside agents/ or teams/ is refused', () => {
  const manifestWith = (copy: string): unknown => ({
    groups: [{ id: 'x', canonical: 'agents/lead/skills/x', copies: [copy] }],
    forks: [],
  })
  for (const copy of [
    '/tmp/elsewhere',
    '../outside/skills/x',
    'agents/../core',
    'agents/helper/../../core',
    'core/skills/x',
    'agents',
    'agents/helper\\skills\\x',
    'agents//skills/x',
    'agents/./helper/skills/x',
    'agents/x/skills',
    'agents/x/skills/y/references',
    'agents/x/other',
    'agents/x/references/extra',
    'teams/x/skills/y',
  ]) {
    assert.equal(parseSharedContentManifest(manifestWith(copy)).ok, false, `${copy} must be refused`)
  }
})

test('a manifest where one listed folder contains another is refused', () => {
  const nested = parseSharedContentManifest({
    groups: [{ id: 'x', canonical: 'agents/lead/skills/x', copies: ['agents/lead/skills/x/references'] }],
    forks: [],
  })
  assert.equal(nested.ok, false)
  const forkInsideCopy = parseSharedContentManifest({
    groups: [{ id: 'x', canonical: 'agents/lead/skills/x', copies: ['agents/helper/skills'] }],
    forks: [{ path: 'agents/helper/skills/x', of: 'x', reason: 'Variant.' }],
  })
  assert.equal(forkInsideCopy.ok, false)
})

test('syncing refuses a copy reached through a symlink, and deletes nothing outside the tree', () => {
  const root = fixture()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shared-content-outside-'))
  try {
    writeTree(outside, 'skills/review-checklist', { 'precious.md': 'Must survive.\n' })
    fs.rmSync(path.join(root, 'agents/helper'), { recursive: true, force: true })
    fs.symlinkSync(outside, path.join(root, 'agents/helper'), 'dir')

    assert.throws(() => syncSharedContent(root, MANIFEST), /symbolic link/u)
    assert.equal(
      fs.readFileSync(path.join(outside, 'skills/review-checklist/precious.md'), 'utf8'),
      'Must survive.\n',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('syncing refuses a symlink inside a shared tree', () => {
  const root = fixture()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shared-content-outside-'))
  try {
    fs.symlinkSync(outside, path.join(root, 'agents/lead/skills/review-checklist/linked'), 'dir')
    assert.throws(() => syncSharedContent(root, MANIFEST), /symbolic link/u)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('syncing refuses a missing canonical source and leaves every copy in place', () => {
  const root = fixture()
  try {
    fs.rmSync(path.join(root, 'agents/lead'), { recursive: true, force: true })
    const helperBefore = readTree(root, 'agents/helper/skills/review-checklist')

    assert.throws(() => syncSharedContent(root, MANIFEST), /canonical/u)
    assert.deepEqual(readTree(root, 'agents/helper/skills/review-checklist'), helperBefore)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a manifest path that differs from another only in letter case is refused', () => {
  const result = parseSharedContentManifest({
    groups: [{ id: 'x', canonical: 'agents/lead/skills/review-checklist', copies: ['agents/Variant/skills/review-checklist'] }],
    forks: [{ path: 'agents/variant/skills/review-checklist', of: 'x', reason: 'Variant.' }],
  })
  assert.equal(result.ok, false)
})

test('syncing refuses a copy whose agent folder does not exist, and creates nothing', () => {
  const root = fixture()
  try {
    const manifest: SharedContentManifest = {
      groups: [{ id: 'review-checklist', canonical: 'agents/lead/skills/review-checklist', copies: ['agents/typo-agent/skills/review-checklist'] }],
      forks: [],
    }
    assert.throws(() => syncSharedContent(root, manifest), /agents\/typo-agent/u)
    assert.equal(fs.existsSync(path.join(root, 'agents/typo-agent')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a copy whose file lost or gained the executable bit is reported, and syncing restores it', () => {
  const root = fixture()
  try {
    fs.chmodSync(path.join(root, 'agents/helper/skills/review-checklist/references/rules.md'), 0o755)
    assert.deepEqual(findSharedContentDrift(root, MANIFEST), [
      { group: 'review-checklist', copy: 'agents/helper/skills/review-checklist', file: 'references/rules.md', kind: 'mode' },
    ])
    syncSharedContent(root, MANIFEST)
    assert.equal(fs.statSync(path.join(root, 'agents/helper/skills/review-checklist/references/rules.md')).mode & 0o111, 0)
    assert.deepEqual(findSharedContentDrift(root, MANIFEST), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Finder metadata files are neither drift nor copied', () => {
  const root = fixture()
  try {
    fs.writeFileSync(path.join(root, 'agents/helper/skills/review-checklist/.DS_Store'), 'finder')
    fs.writeFileSync(path.join(root, 'agents/lead/skills/review-checklist/.DS_Store'), 'finder')
    assert.deepEqual(findSharedContentDrift(root, MANIFEST), [])

    fs.writeFileSync(path.join(root, 'agents/second/skills/review-checklist/SKILL.md'), '# Edited\n')
    syncSharedContent(root, MANIFEST)
    assert.equal(fs.existsSync(path.join(root, 'agents/second/skills/review-checklist/.DS_Store')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('syncing checks every group before it changes any copy', () => {
  const root = fixture()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shared-content-outside-'))
  try {
    writeTree(root, 'agents/lead/skills/style-guide', { 'SKILL.md': '# Style guide\n' })
    fs.symlinkSync(outside, path.join(root, 'agents/linked'), 'dir')
    fs.writeFileSync(path.join(root, 'agents/helper/skills/review-checklist/SKILL.md'), '# Edited\n')
    const manifest: SharedContentManifest = {
      groups: [
        MANIFEST.groups[0] ?? assert.fail('fixture manifest has a group'),
        { id: 'style-guide', canonical: 'agents/lead/skills/style-guide', copies: ['agents/linked/skills/style-guide'] },
      ],
      forks: [],
    }

    assert.throws(() => syncSharedContent(root, manifest), /symbolic link/u)
    assert.equal(fs.readFileSync(path.join(root, 'agents/helper/skills/review-checklist/SKILL.md'), 'utf8'), '# Edited\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('a manifest that lists a directory twice is refused', () => {
  const result = parseSharedContentManifest({
    groups: [
      { id: 'one', canonical: 'agents/a/skills/x', copies: ['agents/b/skills/x'] },
      { id: 'two', canonical: 'agents/b/skills/x', copies: ['agents/c/skills/x'] },
    ],
    forks: [],
  })
  assert.equal(result.ok, false)
})
