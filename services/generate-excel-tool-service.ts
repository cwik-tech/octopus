import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

import { serialCapabilityEffect } from '../contracts/capability-effect.js'
import { publishRuntimeArtifactWrittenEvent } from '../domains/runtime/artifacts.js'
import type {
  McpBrokerRequestContext,
  McpJsonObject,
  McpNamespacedTool,
} from '../domains/mcp/mcp-runtime.js'
import {
  resolveRelativePathInside,
} from '../core/path-safety.js'
import { buildSessionRunAssignmentLocation } from '../domains/run/run-location.js'
import {
  excelTemplateSummary,
  fillExcelTemplate,
  listExcelTemplates,
  loadExcelTemplate,
  parseExcelTemplateData,
} from '../domains/excel-generation/excel-templates.js'
import { generateExcelBuffer } from '../domains/excel-generation/generate-excel.js'
import { isGenerateExcelEnabledForAgent } from '../domains/excel-generation/generate-excel-policy.js'
import {
  EXCEL_TEMPLATES_DIRECTORY,
  GENERATE_EXCEL_SERVER_ID,
  GENERATE_EXCEL_TOOL_NAME,
  generateExcelToolInputSchema,
  type GenerateExcelAction,
  type GenerateExcelToolInput,
  type GenerateExcelToolOutput,
} from '../domains/excel-generation/generate-excel-types.js'
import { listExcelProfiles } from '../domains/excel-generation/excel-profiles.js'

const MAX_INPUT_BYTES = 10 * 1_024 * 1_024

export interface GenerateExcelToolServiceOptions {
  readonly workspacePath: string
  readonly repoRootPath: string
}

export class GenerateExcelToolService {
  readonly tool: McpNamespacedTool = {
    serverId: GENERATE_EXCEL_SERVER_ID,
    serverName: 'Generate Excel',
    toolName: GENERATE_EXCEL_TOOL_NAME,
    namespacedName: GENERATE_EXCEL_TOOL_NAME,
    description: [
      'Generate a profile-driven Excel workbook from Markdown tables in the current assignment,',
      'or fill a curated workbook template with a JSON data artifact while preserving the',
      'template formulas, formatting, and charts.',
    ].join(' '),
    inputSchema: generateExcelToolInputSchema(),
    annotations: { openWorldHint: false },
    risk: 'mutating',
    effect: serialCapabilityEffect('mutating'),
    requiresApproval: false,
  }

  private readonly workspacePath: string
  private readonly repoRootPath: string

  constructor(options: GenerateExcelToolServiceOptions) {
    this.workspacePath = path.resolve(options.workspacePath)
    this.repoRootPath = path.resolve(options.repoRootPath)
  }

  isEnabledForAgent(agentPath: string): boolean {
    return isGenerateExcelEnabledForAgent(this.repoRootPath, agentPath)
  }

  private get templatesRoot(): string {
    return path.join(this.repoRootPath, ...EXCEL_TEMPLATES_DIRECTORY.split('/'))
  }

  async execute(
    context: McpBrokerRequestContext,
    _toolCallId: string,
    rawInput: McpJsonObject,
    signal?: AbortSignal,
  ): Promise<GenerateExcelToolOutput> {
    let input: GenerateExcelToolInput
    try {
      input = parseGenerateExcelToolInput(rawInput)
    } catch (error) {
      return failure(
        fallbackAction(rawInput.action),
        'invalid_request',
        error instanceof Error ? error.message : 'Generate Excel input is invalid.',
      )
    }
    if (!this.isEnabledForAgent(context.agentPath)) {
      return failure(
        input.action,
        'not_enabled',
        'This agent is not allowed to use Generate Excel.',
      )
    }
    if (input.action === 'list_profiles') {
      return {
        ok: true,
        action: input.action,
        profiles: listExcelProfiles().map((profile) => ({
          id: profile.id,
          displayName: profile.displayName,
          description: profile.description,
        })),
      }
    }
    if (input.action === 'list_templates') {
      const listed = listExcelTemplates(this.templatesRoot)
      return {
        ok: true,
        action: input.action,
        templates: listed.templates.map(excelTemplateSummary),
        warnings: listed.warnings,
      }
    }
    const assignmentPath = await this.resolveAssignmentPath(context)
    if (!assignmentPath) {
      return failure(
        input.action,
        'invalid_request',
        'Generate Excel assignment scope is unavailable.',
      )
    }
    try {
      const { inputPath: relativeInputPath, outputPath: relativeOutputPath } = input
      if (relativeInputPath === undefined || relativeOutputPath === undefined) {
        throw new Error(
          `Generate Excel ${input.action} input was parsed without inputPath and outputPath.`,
        )
      }
      const inputExtension = input.action === 'generate' ? '.md' : '.json'
      const inputPath = await requireExistingRegularFile(
        assignmentPath,
        relativeInputPath,
        inputExtension,
      )
      const outputPath = await prepareOutputPath(
        assignmentPath,
        relativeOutputPath,
        '.xlsx',
      )
      const inputStat = await fs.stat(inputPath)
      if (inputStat.size > MAX_INPUT_BYTES) {
        return failure(
          input.action,
          'invalid_request',
          'Generate Excel input exceeds the 10 MB limit.',
        )
      }
      const source = await fs.readFile(inputPath, 'utf8')
      let buffer: Buffer
      let warnings: readonly string[]
      let profileId: string | undefined
      let sheetNames: readonly string[] | undefined
      if (input.action === 'generate') {
        const generated = await generateExcelBuffer(source, {
          profile: input.profile ?? 'business-workbook',
          ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
        })
        buffer = generated.buffer
        warnings = generated.warnings
        profileId = generated.profile.id
        sheetNames = generated.sheetNames
      } else {
        if (input.template === undefined) {
          throw new Error('Generate Excel fill_template input was parsed without a template.')
        }
        const template = loadExcelTemplate(this.templatesRoot, input.template)
        const filled = await fillExcelTemplate(
          template,
          parseExcelTemplateData(JSON.parse(source)),
          signal,
        )
        buffer = filled.buffer
        warnings = filled.warnings
      }
      const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
      try {
        await fs.writeFile(temporaryPath, buffer, { mode: 0o600 })
        await fs.rename(temporaryPath, outputPath)
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      }
      publishRuntimeArtifactWrittenEvent({
        outputDir: assignmentPath,
        relativePath: relativeOutputPath,
        artifactType: 'excel-document',
        artifactRole: 'final',
        sessionId: context.assignmentId,
        rootSessionId: context.runId,
        title: path.basename(outputPath),
      })
      return {
        ok: true,
        action: input.action,
        ...whenDefined(input.outputPath, (outputPath) => ({ outputPath: outputPath })),
        sizeBytes: buffer.byteLength,
        digest: createHash('sha256').update(buffer).digest('hex'),
        ...(profileId ? { profile: profileId } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(sheetNames ? { sheetNames } : {}),
        warnings,
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return failure(input.action, 'cancelled', 'Generate Excel was cancelled.')
      }
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return failure(
          input.action,
          'not_found',
          'Generate Excel input artifact was not found.',
        )
      }
      if (error instanceof GenerateExcelRequestError) {
        return failure(input.action, 'invalid_request', error.message)
      }
      if (error instanceof SyntaxError) {
        return failure(
          input.action,
          'invalid_request',
          `Generate Excel data artifact is not valid JSON: ${error.message}`,
        )
      }
      return failure(
        input.action,
        'generation_failed',
        error instanceof Error ? error.message : 'Excel generation failed.',
      )
    }
  }

  private async resolveAssignmentPath(
    context: McpBrokerRequestContext,
  ): Promise<string | null> {
    const location = buildSessionRunAssignmentLocation(
      this.workspacePath,
      context,
    )
    if (!location) return null
    try {
      const expectedPath = path.join(
        this.workspacePath,
        ...location.relativeAssignmentPath.split('/'),
      )
      const [workspaceReal, assignmentReal, stat] = await Promise.all([
        fs.realpath(this.workspacePath),
        fs.realpath(expectedPath),
        fs.lstat(expectedPath),
      ])
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        assignmentReal !== path.resolve(expectedPath) ||
        !assignmentReal.startsWith(`${workspaceReal}${path.sep}`)
      ) return null
      return assignmentReal
    } catch {
      return null
    }
  }
}

export function parseGenerateExcelToolInput(
  value: unknown,
): GenerateExcelToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  const allowed = new Set([
    'action',
    'inputPath',
    'outputPath',
    'profile',
    'template',
  ])
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid()
  const action = input.action
  if (
    action !== 'list_profiles' &&
    action !== 'list_templates' &&
    action !== 'generate' &&
    action !== 'fill_template'
  ) invalid()
  if (
    input.inputPath !== undefined && typeof input.inputPath !== 'string' ||
    input.outputPath !== undefined && typeof input.outputPath !== 'string' ||
    input.profile !== undefined && typeof input.profile !== 'string' ||
    input.template !== undefined && typeof input.template !== 'string'
  ) invalid()
  if (action === 'generate' || action === 'fill_template') {
    if (
      typeof input.inputPath !== 'string' ||
      !input.inputPath.trim() ||
      input.inputPath.length > 512 ||
      typeof input.outputPath !== 'string' ||
      !input.outputPath.trim() ||
      input.outputPath.length > 512
    ) invalid()
    if (action === 'generate' && input.template !== undefined) invalid()
    if (action === 'fill_template') {
      if (
        typeof input.template !== 'string' ||
        !input.template.trim() ||
        input.template.length > 128 ||
        input.profile !== undefined
      ) invalid()
    }
  } else if (
    input.inputPath !== undefined ||
    input.outputPath !== undefined ||
    input.profile !== undefined ||
    input.template !== undefined
  ) {
    invalid()
  }
  return {
    action,
    ...whenDefined(input.inputPath as string | undefined, (inputPath) => ({ inputPath })),
    ...whenDefined(input.outputPath as string | undefined, (outputPath) => ({ outputPath })),
    ...whenDefined(input.profile as string | undefined, (profile) => ({ profile })),
    ...whenDefined(input.template as string | undefined, (template) => ({ template })),
  }
}

async function requireExistingRegularFile(
  assignmentPath: string,
  relativePath: string,
  extension: string,
): Promise<string> {
  if (path.extname(relativePath).toLowerCase() !== extension) invalid()
  const target = resolveRelativePathInside(assignmentPath, relativePath)
  if (!target) invalid()
  const [real, stat] = await Promise.all([fs.realpath(target), fs.lstat(target)])
  if (real !== target || !stat.isFile() || stat.isSymbolicLink()) invalid()
  return target
}

async function prepareOutputPath(
  assignmentPath: string,
  relativePath: string,
  extension: string,
): Promise<string> {
  if (path.extname(relativePath).toLowerCase() !== extension) invalid()
  const target = resolveRelativePathInside(assignmentPath, relativePath)
  if (!target) invalid()
  const relativeParent = path.dirname(relativePath).replaceAll('\\', '/')
  const segments = relativeParent === '.'
    ? []
    : relativeParent.split('/')
  let current = assignmentPath
  for (const segment of segments) {
    current = path.join(current, segment)
    await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const [real, stat] = await Promise.all([fs.realpath(current), fs.lstat(current)])
    if (real !== current || !stat.isDirectory() || stat.isSymbolicLink()) invalid()
  }
  try {
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink()) invalid()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}

function failure(
  action: GenerateExcelAction,
  code: NonNullable<GenerateExcelToolOutput['error']>['code'],
  message: string,
): GenerateExcelToolOutput {
  return {
    ok: false,
    action,
    error: {
      code,
      message,
      retryable: code === 'internal',
    },
  }
}

function fallbackAction(value: unknown): GenerateExcelAction {
  if (value === 'list_profiles' || value === 'list_templates' || value === 'fill_template') {
    return value
  }
  return 'generate'
}

class GenerateExcelRequestError extends Error {
  constructor() {
    super('Generate Excel request is invalid.')
    this.name = 'GenerateExcelRequestError'
  }
}

function invalid(): never {
  throw new GenerateExcelRequestError()
}
