/**
 * Keeps agent content that is shared by copying in step with its source.
 *
 * Skills are loaded from each agent's own folder, so a skill several agents
 * use is copied into each of them rather than linked. The manifest beside
 * this script names every such group, the one copy that is edited, and the
 * copies that follow it. A deliberate variant is listed as a fork and is
 * never compared or overwritten.
 *
 *   npm run agents:check-shared   report copies that differ from their source
 *   npm run agents:sync-shared    overwrite those copies from their source
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

/**
 * Sync deletes and rewrites the folders it lists, so a listed path must name
 * exactly one skill or one package folder, and nothing wider:
 * `agents/<agent>/skills/<skill>`, or `references` or `templates` directly
 * under `agents/<agent>/` or `teams/<team>/`. These shapes cannot nest, so no
 * listed folder can contain another. Every segment is lowercase kebab-case, as
 * agent and skill names already are: on a case-insensitive disk two spellings
 * of one folder would otherwise pass the listed-twice check.
 */
const PATH_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

function isSharedContentPath(value: string): boolean {
  const segments = value.split('/')
  if (!segments.every((segment) => PATH_SEGMENT.test(segment))) return false
  const [top, , area] = segments
  if (segments.length === 4) return top === 'agents' && area === 'skills'
  if (segments.length === 3) {
    return (top === 'agents' || top === 'teams') && (area === 'references' || area === 'templates')
  }
  return false
}

const sharedContentPathSchema = z.string().refine(isSharedContentPath, {
  message: 'must be agents/<agent>/skills/<skill>, or agents/<agent>/ or teams/<team>/ followed by references or templates',
})

const sharedContentGroupSchema = z.object({
  id: z.string().min(1),
  canonical: sharedContentPathSchema,
  copies: z.array(sharedContentPathSchema).min(1),
})

const sharedContentForkSchema = z.object({
  path: sharedContentPathSchema,
  of: z.string().min(1),
  reason: z.string().min(1),
})

const sharedContentManifestSchema = z
  .object({
    groups: z.array(sharedContentGroupSchema),
    forks: z.array(sharedContentForkSchema),
  })
  .superRefine((manifest, context) => {
    const seen = new Set<string>()
    const listed = [
      ...manifest.groups.flatMap((group) => [group.canonical, ...group.copies]),
      ...manifest.forks.map((fork) => fork.path),
    ]
    for (const directory of listed) {
      if (seen.has(directory)) {
        context.addIssue({ code: 'custom', message: `${directory} is listed more than once` })
      }
      seen.add(directory)
    }
  })

export type SharedContentManifest = z.infer<typeof sharedContentManifestSchema>

export interface SharedContentDrift {
  readonly group: string
  readonly copy: string
  readonly file: string
  readonly kind: 'changed' | 'missing' | 'extra' | 'mode'
}

export type SharedContentManifestResult =
  | { readonly ok: true; readonly manifest: SharedContentManifest }
  | { readonly ok: false; readonly error: string }

export function parseSharedContentManifest(value: unknown): SharedContentManifestResult {
  const result = sharedContentManifestSchema.safeParse(value)
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((issue) => issue.message).join('; ') }
  }
  return { ok: true, manifest: result.data }
}

export function readSharedContentManifest(file: string): SharedContentManifest {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  const result = parseSharedContentManifest(raw)
  if (!result.ok) throw new Error(`${file} is not a valid shared-content manifest: ${result.error}`)
  return result.manifest
}

/**
 * The absolute folder for a listed path. Refuses any symbolic link on the way,
 * so a listed folder cannot resolve outside the tree it names, and a missing
 * agent or Team folder, so a mistyped name cannot create a new one.
 */
function listedDirectory(root: string, relative: string, role: 'canonical source' | 'copy'): string {
  const segments = relative.split('/')
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) {
      if (index < 2) throw new Error(`${role} ${relative}: ${segments.slice(0, index + 1).join('/')} does not exist`)
      break
    }
    if (stat.isSymbolicLink()) throw new Error(`${role} ${relative} passes through a symbolic link at ${path.relative(root, current)}`)
  }
  return path.join(root, relative)
}

/** Operating-system files that git ignores and that are never shared content. */
const IGNORED_FILE_NAMES = new Set(['.DS_Store'])

/** Every file under a directory, as paths relative to it with `/` separators. Refuses symbolic links. */
function listFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (IGNORED_FILE_NAMES.has(entry.name)) continue
      if (entry.isSymbolicLink()) throw new Error(`${entryPath} is a symbolic link; shared content must be plain files`)
      if (entry.isDirectory()) walk(entryPath)
      else files.push(path.relative(directory, entryPath).split(path.sep).join('/'))
    }
  }
  walk(directory)
  return files.sort()
}

/** Git records only whether a file is executable, so that is the part of the mode compared. */
function executableBits(file: string): number {
  return fs.statSync(file).mode & 0o111
}

export function findSharedContentDrift(root: string, manifest: SharedContentManifest): SharedContentDrift[] {
  const drift: SharedContentDrift[] = []
  for (const group of manifest.groups) {
    const canonicalDirectory = listedDirectory(root, group.canonical, 'canonical source')
    const canonicalFiles = listFiles(canonicalDirectory)
    if (canonicalFiles.length === 0) throw new Error(`canonical source ${group.canonical} is missing or empty`)
    for (const copy of group.copies) {
      const copyDirectory = listedDirectory(root, copy, 'copy')
      const copyFiles = new Set(listFiles(copyDirectory))
      for (const file of canonicalFiles) {
        if (!copyFiles.has(file)) {
          drift.push({ group: group.id, copy, file, kind: 'missing' })
        } else if (!fs.readFileSync(path.join(canonicalDirectory, file)).equals(fs.readFileSync(path.join(copyDirectory, file)))) {
          drift.push({ group: group.id, copy, file, kind: 'changed' })
        } else if (executableBits(path.join(canonicalDirectory, file)) !== executableBits(path.join(copyDirectory, file))) {
          drift.push({ group: group.id, copy, file, kind: 'mode' })
        }
      }
      const canonicalSet = new Set(canonicalFiles)
      for (const file of copyFiles) {
        if (!canonicalSet.has(file)) drift.push({ group: group.id, copy, file, kind: 'extra' })
      }
    }
  }
  return drift.sort((a, b) => a.copy.localeCompare(b.copy) || a.file.localeCompare(b.file))
}

/**
 * Replaces every drifted copy with its canonical source's listed files and
 * their modes; returns the copies it wrote. Every listed folder is checked
 * before anything is deleted, and forks are never touched.
 */
export function syncSharedContent(root: string, manifest: SharedContentManifest): string[] {
  const drifted = new Set(findSharedContentDrift(root, manifest).map((entry) => entry.copy))
  const plan = manifest.groups.flatMap((group) => {
    const source = listedDirectory(root, group.canonical, 'canonical source')
    const files = listFiles(source)
    return group.copies
      .filter((copy) => drifted.has(copy))
      .map((copy) => ({ source, files, target: listedDirectory(root, copy, 'copy'), copy }))
  })
  for (const { source, files, target } of plan) {
    fs.rmSync(target, { recursive: true, force: true })
    for (const file of files) {
      const from = path.join(source, file)
      const to = path.join(target, file)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      fs.chmodSync(to, fs.statSync(from).mode & 0o777)
    }
  }
  return plan.map((step) => step.copy).sort()
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = readSharedContentManifest(path.join(repoRoot, 'scripts', 'agent-shared-content.json'))
  if (process.argv.includes('--write')) {
    // Name every file the sync discards, so an edit made in a copy by mistake
    // is visible before it is overwritten.
    for (const entry of findSharedContentDrift(repoRoot, manifest)) {
      if (entry.kind !== 'missing') process.stdout.write(`Overwriting ${entry.copy}/${entry.file} (${entry.kind})\n`)
    }
    const written = syncSharedContent(repoRoot, manifest)
    process.stdout.write(written.length ? `Updated ${written.length} copies:\n${written.join('\n')}\n` : 'Every copy already matches its source.\n')
    return
  }
  const drift = findSharedContentDrift(repoRoot, manifest)
  if (drift.length === 0) {
    process.stdout.write('Every copy matches its source.\n')
    return
  }
  for (const entry of drift) process.stderr.write(`${entry.copy}/${entry.file}: ${entry.kind} (group ${entry.group})\n`)
  process.stderr.write('Edit the canonical copy named in scripts/agent-shared-content.json, then run npm run agents:sync-shared.\n')
  process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
