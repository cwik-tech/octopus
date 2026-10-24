/**
 * Agent content shared by copying stays in step with its one editable source.
 *
 * `scripts/agent-shared-content.json` names each group of copies and the copy
 * that is edited. These tests read the real `agents/` and `teams/` folders.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import {
  findSharedContentDrift,
  readSharedContentManifest,
} from '../../scripts/agent-shared-content.js'
import { SkillLoaderService } from '../../services/skill-loader-service.js'

const repoRoot = process.cwd()
const manifest = readSharedContentManifest(path.join(repoRoot, 'scripts', 'agent-shared-content.json'))

function listFiles(directory: string): string[] {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) walk(entryPath)
      else files.push(path.relative(directory, entryPath))
    }
  }
  walk(directory)
  return files.sort()
}

function sameTree(left: string, right: string): boolean {
  const leftFiles = listFiles(left)
  const rightFiles = listFiles(right)
  return (
    leftFiles.length === rightFiles.length &&
    leftFiles.every((file, index) =>
      file === rightFiles[index] &&
      fs.readFileSync(path.join(left, file)).equals(fs.readFileSync(path.join(right, file))),
    )
  )
}

const listed = new Set([
  ...manifest.groups.flatMap((group) => [group.canonical, ...group.copies]),
  ...manifest.forks.map((fork) => fork.path),
])

function agentDirectories(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, 'agents'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

test('every copy of shared agent content matches its source', () => {
  const drift = findSharedContentDrift(repoRoot, manifest)
  assert.deepEqual(
    drift,
    [],
    'Edit the canonical copy named in scripts/agent-shared-content.json, then run npm run agents:sync-shared.',
  )
})

test('every agent skill that shares its name with a shared group is listed as a copy or a fork', () => {
  const sharedSkillNames = new Set(
    manifest.groups
      .map((group) => group.canonical.split('/'))
      .filter((parts) => parts[0] === 'agents' && parts[2] === 'skills')
      .map((parts) => parts[3]),
  )
  const unlisted = agentDirectories().flatMap((agent) =>
    [...sharedSkillNames]
      .map((skill) => `agents/${agent}/skills/${skill}`)
      .filter((directory) => fs.existsSync(path.join(repoRoot, directory)) && !listed.has(directory)),
  )
  assert.deepEqual(unlisted, [], 'A new copy must join its group in scripts/agent-shared-content.json, or be listed as a fork.')
})

test('no unlisted folder duplicates a shared group', () => {
  const candidates = [
    ...agentDirectories().flatMap((agent) => {
      const skillsDirectory = path.join(repoRoot, 'agents', agent, 'skills')
      const skills = fs.existsSync(skillsDirectory)
        ? fs.readdirSync(skillsDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `agents/${agent}/skills/${entry.name}`)
        : []
      return [...skills, `agents/${agent}/references`, `agents/${agent}/templates`]
    }),
    ...fs.readdirSync(path.join(repoRoot, 'teams'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [`teams/${entry.name}/references`, `teams/${entry.name}/templates`]),
  ].filter((directory) => !listed.has(directory) && fs.existsSync(path.join(repoRoot, directory)))

  const duplicates = candidates.flatMap((directory) =>
    manifest.groups
      .filter((group) => sameTree(path.join(repoRoot, group.canonical), path.join(repoRoot, directory)))
      .map((group) => `${directory} duplicates ${group.id}`),
  )
  assert.deepEqual(duplicates, [])
})

function treeDigest(directory: string): string {
  const hash = createHash('sha256')
  for (const file of listFiles(directory)) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(directory, file))).update('\0')
  }
  return hash.digest('hex')
}

test('identical skill folders, and identical references or templates folders, form one shared group', () => {
  const folders: Array<{ readonly kind: string; readonly directory: string }> = [
    ...agentDirectories().flatMap((agent) => {
      const skillsDirectory = path.join(repoRoot, 'agents', agent, 'skills')
      const skills = fs.existsSync(skillsDirectory)
        ? fs.readdirSync(skillsDirectory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ kind: 'skill', directory: `agents/${agent}/skills/${entry.name}` }))
        : []
      return [
        ...skills,
        { kind: 'references', directory: `agents/${agent}/references` },
        { kind: 'templates', directory: `agents/${agent}/templates` },
      ]
    }),
    ...fs.readdirSync(path.join(repoRoot, 'teams'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        { kind: 'references', directory: `teams/${entry.name}/references` },
        { kind: 'templates', directory: `teams/${entry.name}/templates` },
      ]),
  ].filter(({ directory }) => {
    const absolute = path.join(repoRoot, directory)
    return fs.existsSync(absolute) && listFiles(absolute).length > 0
  })

  const byContent = new Map<string, string[]>()
  for (const { kind, directory } of folders) {
    const key = `${kind}:${treeDigest(path.join(repoRoot, directory))}`
    byContent.set(key, [...(byContent.get(key) ?? []), directory])
  }
  const groupMembers = manifest.groups.map((group) => new Set([group.canonical, ...group.copies]))
  const ungrouped = [...byContent.values()]
    .filter((directories) => directories.length > 1)
    .filter((directories) => !groupMembers.some((members) => directories.every((directory) => members.has(directory))))
    .map((directories) => directories.join(', '))
  assert.deepEqual(ungrouped, [], 'Identical folders must be one group in scripts/agent-shared-content.json.')
})

/** Relative file references in Markdown links and code spans. */
function relativeReferences(markdown: string): string[] {
  const candidates = [
    ...[...markdown.matchAll(/\]\(([^)\s]+)\)/gu)].map((match) => match[1] ?? ''),
    ...[...markdown.matchAll(/`([^`\s]+)`/gu)].map((match) => match[1] ?? ''),
  ]
  return [...new Set(candidates.filter((reference) =>
    /^(\.\.?\/|references\/|templates\/|scripts\/|assets\/)/u.test(reference) &&
    /\.[a-z0-9]+$/iu.test(reference),
  ))]
}

// A reference may be written from the file's own folder or from the shared
// folder's root, which is how the skill files write `references/...`.
test("every relative reference in shared Markdown resolves from each copy's own folder", () => {
  const broken = manifest.groups.flatMap((group) => {
    const canonicalRoot = path.join(repoRoot, group.canonical)
    const markdownFiles = listFiles(canonicalRoot).filter((file) => file.endsWith('.md'))
    return markdownFiles.flatMap((file) => {
      const references = relativeReferences(fs.readFileSync(path.join(canonicalRoot, file), 'utf8'))
      return [group.canonical, ...group.copies].flatMap((directory) => {
        const copyRoot = path.join(repoRoot, directory)
        const fileFolder = path.dirname(path.join(copyRoot, file))
        return references
          .filter((reference) =>
            !fs.existsSync(path.join(fileFolder, reference)) && !fs.existsSync(path.join(copyRoot, reference)),
          )
          .map((reference) => `${directory}/${file} -> ${reference}`)
      })
    })
  })
  assert.deepEqual(broken, [])
})

test('every copy of a shared skill loads through the skill loader as its own agent', async () => {
  const realRoot = fs.realpathSync(repoRoot)
  const loader = new SkillLoaderService({ repoRootPath: realRoot })
  const skillFolders = manifest.groups
    .flatMap((group) => [group.canonical, ...group.copies])
    .filter((directory) => directory.split('/')[2] === 'skills')
  const failures: string[] = []
  for (const directory of skillFolders) {
    const [, agent] = directory.split('/')
    const source = path.join(realRoot, directory, 'SKILL.md')
    const content = fs.readFileSync(source, 'utf8')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const output = await loader.execute(`agents/${agent}`, { source, sha256 })
    if (!output.ok || output.content !== content) failures.push(directory)
  }
  assert.ok(skillFolders.length > 0)
  assert.deepEqual(failures, [])
})
