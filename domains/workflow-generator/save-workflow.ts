/**
 * Persists a validated `WorkflowDraft` to disk and registers it in
 * `workflows/registry.yaml` so the existing loader picks it up automatically.
 *
 * - Writes the YAML to `workflows/user-generated/<filename>.yaml`.
 * - Idempotently rewrites the registry entry keyed by the saved workflow id
 *   (so re-saving the same name replaces the entry rather than duplicating).
 *
 * Pre-validation is the caller's responsibility — if validation passes the
 * write proceeds; if not, the API route refuses before calling this.
 */

import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import { buildWorkflowYaml } from './yaml-builder.js'
import { parseWorkflowYaml } from './yaml-parser.js'
import type { WorkflowDraft } from './workflow-draft.js'
import {
  throwIfSignalAborted,
  withFileMutationLock,
  writeFileAtomic,
} from '../../core/file-mutation.js'

export class WorkflowWriteConflictError extends Error {
  constructor(workflowPath: string) {
    super(`Workflow file already exists with different content: ${workflowPath}`)
    this.name = 'WorkflowWriteConflictError'
  }
}

export interface SaveWorkflowResult {
  workflowId: string
  yamlPath: string
  registryPath: string
  filename: string
}

export interface UpdateExistingWorkflowYamlResult {
  workflowId: string
  yaml: string
  yamlPath: string
  registryPath: string
  filename: string
}

export async function saveWorkflow(params: {
  draft: WorkflowDraft
  filename: string
  repoRoot: string
  registryPath?: string
  signal?: AbortSignal
}): Promise<SaveWorkflowResult> {
  throwIfSignalAborted(params.signal)
  const safeFilename = sanitizeFilename(params.filename)
  const savedDraft: WorkflowDraft = {
    ...params.draft,
    id: safeFilename,
  }
  const registryPath = params.registryPath ?? path.join(params.repoRoot, 'workflows', 'registry.yaml')
  const targetDir = path.join(path.dirname(registryPath), 'user-generated')
  await fs.mkdir(targetDir, { recursive: true })
  throwIfSignalAborted(params.signal)

  const yamlPath = path.join(targetDir, `${safeFilename}.yaml`)
  const yaml = buildWorkflowYaml(savedDraft)
  await writeNewWorkflowFile(yamlPath, yaml, params.signal)

  await fs.mkdir(path.dirname(registryPath), { recursive: true })
  throwIfSignalAborted(params.signal)
  await upsertRegistryEntry({
    registryPath,
    workflowId: savedDraft.id,
    description: savedDraft.description,
    templateRelPath: `./user-generated/${safeFilename}.yaml`,
    ...whenDefined(savedDraft.matches, (definedValue) => ({ matches: definedValue })),
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  })

  return {
    workflowId: savedDraft.id,
    yamlPath,
    registryPath,
    filename: `${safeFilename}.yaml`,
  }
}

export async function saveWorkflowYaml(params: {
  yaml: string
  filename?: string
  replaceWorkflowId?: string
  repoRoot: string
  registryPath?: string
  signal?: AbortSignal
}): Promise<SaveWorkflowResult & { draft: WorkflowDraft }> {
  throwIfSignalAborted(params.signal)
  const draft = parseWorkflowYaml(params.yaml)
  const safeFilename = sanitizeFilename(params.filename ?? draft.id)
  const savedDraft: WorkflowDraft = {
    ...draft,
    id: safeFilename,
  }
  const savedYaml = replaceWorkflowYamlId(params.yaml, safeFilename)
  const registryPath = params.registryPath ?? path.join(params.repoRoot, 'workflows', 'registry.yaml')
  const targetDir = path.join(path.dirname(registryPath), 'user-generated')
  await fs.mkdir(targetDir, { recursive: true })
  throwIfSignalAborted(params.signal)

  const yamlPath = path.join(targetDir, `${safeFilename}.yaml`)
  await writeNewWorkflowFile(yamlPath, savedYaml, params.signal)

  await fs.mkdir(path.dirname(registryPath), { recursive: true })
  throwIfSignalAborted(params.signal)
  await upsertRegistryEntry({
    registryPath,
    ...whenDefined(params.replaceWorkflowId, (definedValue) => ({ replaceWorkflowId: definedValue })),
    workflowId: savedDraft.id,
    description: savedDraft.description,
    templateRelPath: `./user-generated/${safeFilename}.yaml`,
    ...whenDefined(savedDraft.matches, (definedValue) => ({ matches: definedValue })),
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  })

  return {
    workflowId: savedDraft.id,
    yamlPath,
    registryPath,
    filename: `${safeFilename}.yaml`,
    draft: savedDraft,
  }
}

export async function updateExistingWorkflowYaml(params: {
  workflowId: string
  yaml: string
  registryPath: string
  signal?: AbortSignal
}): Promise<UpdateExistingWorkflowYamlResult> {
  throwIfSignalAborted(params.signal)
  const registry = await readRegistryEntry({
    registryPath: params.registryPath,
    workflowId: params.workflowId,
  })
  const draft = parseWorkflowYaml(params.yaml)
  const safeWorkflowId = sanitizeFilename(draft.id)
  const savedYaml = replaceWorkflowYamlId(params.yaml, safeWorkflowId)
  throwIfSignalAborted(params.signal)
  await writeFileAtomic(registry.templatePath, savedYaml)

  throwIfSignalAborted(params.signal)
  await upsertRegistryEntry({
    registryPath: params.registryPath,
    replaceWorkflowId: params.workflowId,
    workflowId: safeWorkflowId,
    description: draft.description,
    templateRelPath: registry.templateRelPath,
    ...whenDefined(registry.tags, (definedValue) => ({ tags: definedValue })),
    ...whenDefined(registry.capabilities, (definedValue) => ({ matches: definedValue })),
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  })

  return {
    workflowId: safeWorkflowId,
    yaml: savedYaml,
    yamlPath: registry.templatePath,
    registryPath: params.registryPath,
    filename: path.basename(registry.templatePath),
  }
}

function replaceWorkflowYamlId(yaml: string, id: string): string {
  const lines = yaml.split('\n')
  const workflowIndex = lines.findIndex((line) => /^workflow:\s*$/.test(line))
  const startIndex = workflowIndex >= 0 ? workflowIndex + 1 : 0
  const workflowLine = workflowIndex >= 0 ? lines[workflowIndex] : undefined
  const workflowIndent = workflowLine?.match(/^\s*/)?.[0]?.length ?? -1
  const idPattern = workflowIndex >= 0
    ? new RegExp(`^\\s{${workflowIndent + 2}}id:\\s*`)
    : /^\s*id:\s*/

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const indent = line.match(/^\s*/)?.[0]?.length ?? 0
    if (workflowIndex >= 0 && line.trim() !== '' && indent <= workflowIndent) break
    if (idPattern.test(line)) {
      const prefix = line.match(/^\s*/)?.[0] ?? ''
      lines[i] = `${prefix}id: ${quoteScalar(id)}`
      return lines.join('\n')
    }
  }

  if (workflowIndex >= 0) {
    lines.splice(workflowIndex + 1, 0, `  id: ${quoteScalar(id)}`)
    return lines.join('\n')
  }

  return `workflow:\n  id: ${quoteScalar(id)}\n${yaml}`
}

function sanitizeFilename(input: string): string {
  const trimmed = (input || '').trim()
  const stripped = trimmed.replace(/\.ya?ml$/i, '')
  const safe = stripped.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '')
  return safe.length > 0 ? safe : 'workflow'
}

interface UpsertParams {
  registryPath: string
  replaceWorkflowId?: string
  workflowId: string
  description: string
  templateRelPath: string
  tags?: string[]
  matches?: string[]
  signal?: AbortSignal
}

async function upsertRegistryEntry(params: UpsertParams): Promise<void> {
  await withFileMutationLock(params.registryPath, async () => {
    throwIfSignalAborted(params.signal)
    let existing = ''
    if (fsSync.existsSync(params.registryPath)) {
      existing = await fs.readFile(params.registryPath, 'utf8')
    }

    let without = stripExistingEntry(existing, params.workflowId)
    if (params.replaceWorkflowId && params.replaceWorkflowId !== params.workflowId) {
      without = stripExistingEntry(without, params.replaceWorkflowId)
    }
    const block = renderRegistryEntry(params)
    const separator = without.length > 0 && !without.endsWith('\n\n')
      ? without.endsWith('\n')
        ? '\n'
        : '\n\n'
      : ''
    const next = `${without}${separator}${block}`
    throwIfSignalAborted(params.signal)
    await writeFileAtomic(params.registryPath, next)
  })
}

async function writeNewWorkflowFile(
  workflowPath: string,
  contents: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfSignalAborted(signal)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(workflowPath, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    await handle?.close().catch(() => undefined)
    handle = undefined
    if (
      error === null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) throw error
    const existing = await fs.readFile(workflowPath, 'utf8')
    if (existing !== contents) throw new WorkflowWriteConflictError(workflowPath)
  }
  throwIfSignalAborted(signal)
}

function renderRegistryEntry(params: UpsertParams): string {
  const lines: string[] = []
  lines.push(`${params.workflowId}:`)
  const desc = params.description.replace(/\s+/g, ' ').trim()
  lines.push(`  description: ${quoteScalar(desc)}`)
  lines.push(`  template_path: ${params.templateRelPath}`)
  if (params.tags && params.tags.length > 0) {
    lines.push('  tags:')
    for (const tag of params.tags) {
      lines.push(`    - ${quoteScalar(tag)}`)
    }
  }
  if (params.matches && params.matches.length > 0) {
    lines.push('  capabilities:')
    for (const match of params.matches) {
      lines.push(`    - ${quoteScalar(match)}`)
    }
  }
  return lines.join('\n') + '\n'
}

async function readRegistryEntry(params: {
  registryPath: string
  workflowId: string
}): Promise<{
  templatePath: string
  templateRelPath: string
  tags?: string[]
  capabilities?: string[]
}> {
  const existing = fsSync.existsSync(params.registryPath)
    ? await fs.readFile(params.registryPath, 'utf8')
    : ''
  const lines = existing.split('\n')
  const start = lines.findIndex((line) => line === `${params.workflowId}:`)
  if (start < 0) {
    const generatedRelPath = `./user-generated/${params.workflowId}.yaml`
    const generatedPath = resolveRegistryTemplatePath(params.registryPath, generatedRelPath)
    if (fsSync.existsSync(generatedPath)) {
      return {
        templatePath: generatedPath,
        templateRelPath: generatedRelPath,
      }
    }
    throw new Error(`Workflow not found: ${params.workflowId}`)
  }

  const block: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (/^[A-Za-z0-9_-]+:/.test(line)) break
    block.push(line)
  }

  const templateRelPath = readIndentedScalar(block, 'template_path')
  if (!templateRelPath) {
    throw new Error(`Workflow registry entry '${params.workflowId}' is missing template_path`)
  }

  return {
    templatePath: resolveRegistryTemplatePath(params.registryPath, templateRelPath),
    templateRelPath,
    ...whenDefined(readIndentedList(block, 'tags'), (tags) => ({ tags: tags })),
    ...whenDefined(readIndentedList(block, 'capabilities'), (capabilities) => ({ capabilities: capabilities })),
  }
}

function readIndentedScalar(lines: string[], key: string): string | undefined {
  const prefix = `  ${key}:`
  const line = lines.find((item) => item.startsWith(prefix))
  if (!line) return undefined
  return unquoteScalar(line.slice(prefix.length).trim())
}

function readIndentedList(lines: string[], key: string): string[] | undefined {
  const start = lines.findIndex((line) => line === `  ${key}:`)
  if (start < 0) return undefined
  const values: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.startsWith('  ') && !line.startsWith('    ')) break
    const match = line.match(/^ {4}-\s*(.*)$/)
    if (match) values.push(unquoteScalar(match[1] ?? ''))
  }
  return values.length > 0 ? values : undefined
}

function resolveRegistryTemplatePath(registryPath: string, templateRelPath: string): string {
  if (path.isAbsolute(templateRelPath)) return templateRelPath
  return path.resolve(path.dirname(registryPath), templateRelPath)
}

/**
 * Removes the YAML block keyed by `workflowId` from registry text. Naive but
 * sufficient for the registry format (top-level keys followed by 2-space
 * indented children, blank-line separated).
 */
function stripExistingEntry(text: string, workflowId: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (skipping) {
      if (/^[A-Za-z0-9_-]+:/.test(line)) {
        skipping = false
        out.push(line)
      } else if (line === '' || /^\s/.test(line)) {
        // still inside the block (indented child or blank line)
        continue
      } else {
        skipping = false
        out.push(line)
      }
      continue
    }
    if (line.startsWith(`${workflowId}:`)) {
      skipping = true
      while (out.length > 0 && out[out.length - 1] === '') out.pop()
      continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

function quoteScalar(value: string): string {
  if (value === '') return "''"
  if (/[:#&*!|>'"%@`{}\[\],\n]/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`
  }
  return value
}

function unquoteScalar(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return value
}
