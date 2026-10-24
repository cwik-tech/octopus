import { normalizeOfficeWorkbook } from './office-candidate-normalization.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { OFFICE_MAX_TARGETS, OFFICE_TARGET_CONTEXT_CHARS, OFFICE_MAX_INSTRUCTION_CHARS, officeOperationsSchema, type OfficeFailure, type OfficeFormat, type OfficeOperation, type OfficeTarget } from '../contracts/office-documents.js'
import { inspectOfficePackage } from '../core/office-package.js'
import { resolveOfficeBinary } from './officecli-binary-resolver.js'
import { runOfficeProcess, officeJobCleanupPending } from './officecli-process.js'
import { readOfficeFile } from './office-preview-source.js'
import { OFFICE_INPUT_MAX_BYTES } from '../contracts/office-documents.js'
export interface OfficeCandidateInput { readonly bytes: Buffer; readonly format: OfficeFormat; readonly repoRoot: string; readonly signal: AbortSignal; readonly lifetime?: { readonly workspacePath: string; readonly sessionId: string } }
const querySchema = z.object({ success: z.literal(true), data: z.object({ matches: z.number().int().nonnegative(), results: z.array(z.object({ path: z.string().max(1024), type: z.string(), text: z.string().max(OFFICE_TARGET_CONTEXT_CHARS).default(''), childCount: z.number().int().nonnegative(), format: z.object({ type: z.string().optional(), formula: z.string().max(OFFICE_TARGET_CONTEXT_CHARS).optional() }).optional() })).max(OFFICE_MAX_TARGETS) }) })
const successSchema = z.object({ success: z.literal(true), warnings: z.array(z.unknown()).max(0).optional() })
const validationSchema = successSchema.extend({ data: z.object({ count: z.literal(0), errors: z.array(z.unknown()).max(0) }) })
type NativeCommand = (args: readonly string[]) => ReturnType<typeof runOfficeProcess>

export async function readOfficeTargets(input: OfficeCandidateInput): Promise<{ ok: true; targets: OfficeTarget[] } | OfficeFailure> {
  return withCandidate<{ ok: true; targets: OfficeTarget[] }>(input, async (_file, command) => captureTargets(input.format, command))
}

export async function applyOfficeOperations(input: OfficeCandidateInput & { operations: readonly OfficeOperation[] }): Promise<{ ok: true; bytes: Buffer } | OfficeFailure> {
  const parsed = officeOperationsSchema.safeParse(input.operations)
  if (!parsed.success || new Set(parsed.data.map((operation) => operation.target)).size !== parsed.data.length) return { ok: false, code: 'invalid_output' }
  return withCandidate<{ ok: true; bytes: Buffer }>(input, async (file, command) => {
    const captured = await captureTargets(input.format, command)
    if (!captured.ok) return captured
    for (const operation of parsed.data) {
      const target = captured.targets.find((candidate) => candidate.id === operation.target)
      if (!target || target.kind !== operation.kind) return { ok: false, code: 'invalid_output' }
      const args = operation.kind === 'text' ? ['set', target.path, '--prop', `text=${escapeProperty(operation.text)}`] : ['set', target.path, '--prop', `value=${escapeProperty(operation.value === null ? '' : String(operation.value))}`, '--prop', `type=${typeof operation.value === 'number' ? 'number' : typeof operation.value === 'boolean' ? 'boolean' : 'string'}`]
      const result = await command(args)
      if (!result.ok) return result
      if (result.stderr.length > 0 || !readJson(result.stdout, successSchema)) return { ok: false, code: 'invalid_output' }
    }
    const validation = await command(['validate'])
    if (!validation.ok) return validation
    if (validation.stderr.length > 0 || !readJson(validation.stdout, validationSchema)) return { ok: false, code: 'invalid_output' }
    let bytes = await readOfficeFile(file, OFFICE_INPUT_MAX_BYTES, input.signal)
    if (input.format === 'xlsx') {
      const normalized = await normalizeOfficeWorkbook(bytes, input.signal)
      if (!normalized.ok) return normalized
      bytes = normalized.bytes
    }
    const inspected = inspectOfficePackage(bytes, input.format)
    return inspected.ok ? { ok: true, bytes } : inspected
  })
}

async function captureTargets(format: OfficeFormat, command: NativeCommand): Promise<{ ok: true; targets: OfficeTarget[] } | OfficeFailure> {
  const response = await command(['query', format === 'docx' ? 'p' : format === 'xlsx' ? 'cell' : 'shape'])
  if (!response.ok) return response
  const result = readJson(response.stdout, querySchema)
  if (!result) return { ok: false, code: 'invalid_output' }
  const targets: OfficeTarget[] = []
  let context = 0
  let paragraph = 0
  for (const entry of result.data.results) {
    if (format === 'docx' && /^\/body\/p\[/.test(entry.path)) paragraph += 1
    // Native type describes the cached scalar even when the cell has a formula.
    const allowed = format === 'docx'
      ? /^\/body\/p\[(?:\d+|@paraId=[A-Fa-f0-9]+)\]$/.test(entry.path) && entry.childCount <= 1
      : format === 'pptx'
        ? /^\/slide\[\d+\]\/shape\[@id=\d+\]$/.test(entry.path)
        : /^\/[^/\\\x00-\x1f]+\/[A-Z]{1,3}[1-9]\d{0,6}$/.test(entry.path) && entry.format?.formula === undefined && entry.format?.type?.toLowerCase() !== 'formula'
    if (!allowed || entry.text.length > OFFICE_MAX_INSTRUCTION_CHARS) continue
    context += entry.text.length
    if (context > OFFICE_TARGET_CONTEXT_CHARS) return { ok: false, code: 'output_limit' }
    targets.push({ id: `target-${targets.length}`, path: format === 'docx' ? `/body/p[${paragraph}]` : entry.path, text: entry.text, kind: format === 'xlsx' ? 'cell' : 'text' })
  }
  return targets.length > 0 ? { ok: true, targets } : { ok: false, code: 'invalid_output' }
}

async function withCandidate<T>(input: OfficeCandidateInput, operation: (file: string, command: NativeCommand) => Promise<T | OfficeFailure>): Promise<T | OfficeFailure> {
  const inspected = inspectOfficePackage(input.bytes, input.format)
  if (!inspected.ok) return inspected
  const executable = await resolveOfficeBinary(input.repoRoot, input.signal)
  if (!executable) return { ok: false, code: 'capability_unavailable' }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-office-edit-'))
  const file = path.join(directory, `candidate.${input.format}`)
  try {
    await fs.writeFile(file, input.bytes, { mode: 0o600 })
    const command: NativeCommand = (args) => {
      const [verb, ...tail] = args
      if (!verb) return Promise.resolve({ ok: false, code: 'invalid_output' })
      return runOfficeProcess({ executable, args: [verb, file, ...tail, '--json'], directory, signal: input.signal, ...(input.lifetime ? { lifetime: input.lifetime } : {}) })
    }
    return await operation(file, command)
  } finally { if (!officeJobCleanupPending(directory)) await fs.rm(directory, { recursive: true, force: true }) }
}

function readJson<T>(bytes: Buffer, schema: z.ZodType<T>): T | undefined {
  try { const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); const parsed = schema.safeParse(raw); return parsed.success ? parsed.data : undefined }
  catch { return undefined }
}
function escapeProperty(value: string): string { return value.replaceAll('\\', '\\\\') }
