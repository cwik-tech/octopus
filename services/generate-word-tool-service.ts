import { whenDefined } from '../core/optional-properties.js'
import { writeFileAtomic } from '../core/file-mutation.js'
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
import { generateWordBuffer } from '../domains/word-generation/generate-word.js'
import { isGenerateWordEnabledForAgent } from '../domains/word-generation/generate-word-policy.js'
import {
  GENERATE_WORD_SERVER_ID,
  GENERATE_WORD_TOOL_NAME,
  generateWordToolInputSchema,
  type GenerateWordAction,
  type GenerateWordToolInput,
  type GenerateWordToolOutput,
} from '../domains/word-generation/generate-word-types.js'
import { listWordProfiles } from '../domains/word-generation/word-profiles.js'

const MAX_MARKDOWN_BYTES = 10 * 1_024 * 1_024

export interface GenerateWordToolServiceOptions {
  readonly workspacePath: string
  readonly repoRootPath: string
  readonly browserExecutablePath?: string
}

export class GenerateWordToolService {
  readonly tool: McpNamespacedTool = {
    serverId: GENERATE_WORD_SERVER_ID,
    serverName: 'Generate Word',
    toolName: GENERATE_WORD_TOOL_NAME,
    namespacedName: GENERATE_WORD_TOOL_NAME,
    description: [
      'Generate a profile-driven Word document from Markdown in the current assignment.',
      'Embeds local images and renders Mermaid diagrams locally to PNG.',
    ].join(' '),
    inputSchema: generateWordToolInputSchema(),
    annotations: { openWorldHint: false },
    risk: 'mutating',
    effect: serialCapabilityEffect('mutating'),
    requiresApproval: false,
  }

  private readonly workspacePath: string
  private readonly repoRootPath: string

  constructor(private readonly options: GenerateWordToolServiceOptions) {
    this.workspacePath = path.resolve(options.workspacePath)
    this.repoRootPath = path.resolve(options.repoRootPath)
  }

  isEnabledForAgent(agentPath: string): boolean {
    return isGenerateWordEnabledForAgent(this.repoRootPath, agentPath)
  }

  async execute(
    context: McpBrokerRequestContext,
    _toolCallId: string,
    rawInput: McpJsonObject,
    signal?: AbortSignal,
  ): Promise<GenerateWordToolOutput> {
    let input: GenerateWordToolInput
    try {
      input = parseGenerateWordToolInput(rawInput)
    } catch (error) {
      return failure(
        fallbackAction(rawInput.action),
        'invalid_request',
        error instanceof Error ? error.message : 'Generate Word input is invalid.',
      )
    }
    if (!this.isEnabledForAgent(context.agentPath)) {
      return failure(
        input.action,
        'not_enabled',
        'This agent is not allowed to use Generate Word.',
      )
    }
    if (input.action === 'list_profiles') {
      return {
        ok: true,
        action: input.action,
        profiles: listWordProfiles().map((profile) => ({
          id: profile.id,
          displayName: profile.displayName,
          description: profile.description,
        })),
      }
    }
    const assignmentPath = await this.resolveAssignmentPath(context)
    if (!assignmentPath) {
      return failure(
        input.action,
        'invalid_request',
        'Generate Word assignment scope is unavailable.',
      )
    }
    try {
      const outputRelativePath = input.outputPath
      if (!outputRelativePath) throw new GenerateWordRequestError()
      const sourceRelativePath = input.inputPath ?? replaceExtension(
        outputRelativePath,
        '.md',
      )
      const inputPath = input.markdown === undefined
        ? await requireExistingRegularFile(
            assignmentPath,
            sourceRelativePath,
            '.md',
          )
        : await prepareOutputPath(
            assignmentPath,
            sourceRelativePath,
            '.md',
          )
      const outputPath = await prepareOutputPath(
        assignmentPath,
        outputRelativePath,
        '.docx',
      )
      const markdown = input.markdown ?? await fs.readFile(inputPath, 'utf8')
      if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
        return failure(
          input.action,
          'invalid_request',
          'Generate Word input exceeds the 10 MB limit.',
        )
      }
      if (input.markdown !== undefined) {
        await writeFileAtomic(inputPath, markdown)
        publishRuntimeArtifactWrittenEvent({
          outputDir: assignmentPath,
          relativePath: sourceRelativePath,
          artifactType: 'markdown-document',
          artifactRole: 'intermediate',
          sessionId: context.assignmentId,
          rootSessionId: context.runId,
          title: `${path.basename(sourceRelativePath)} - Markdown source`,
        })
      }
      const generated = await generateWordBuffer(markdown, {
        profile: input.profile ?? 'business-report',
        ...whenDefined(input.tableOfContents, (definedValue) => ({ tableOfContents: definedValue })),
        ...whenDefined(input.renderMermaid, (definedValue) => ({ renderMermaid: definedValue })),
        sourceDirectory: path.dirname(inputPath),
        ...whenDefined(this.options.browserExecutablePath, (definedValue) => ({ browserExecutablePath: definedValue })),
        ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
      })
      const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
      try {
        await fs.writeFile(temporaryPath, generated.buffer, { mode: 0o600 })
        await fs.rename(temporaryPath, outputPath)
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      }
      publishRuntimeArtifactWrittenEvent({
        outputDir: assignmentPath,
        relativePath: outputRelativePath,
        artifactType: 'word-document',
        artifactRole: 'final',
        sessionId: context.assignmentId,
        rootSessionId: context.runId,
        title: path.basename(outputPath),
      })
      return {
        ok: true,
        action: input.action,
        outputPath: outputRelativePath,
        sourcePath: sourceRelativePath,
        sizeBytes: generated.buffer.byteLength,
        digest: createHash('sha256').update(generated.buffer).digest('hex'),
        profile: generated.profile.id,
        warnings: generated.warnings,
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return failure(input.action, 'cancelled', 'Generate Word was cancelled.')
      }
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return failure(
          input.action,
          'not_found',
          'Generate Word input artifact was not found.',
        )
      }
      if (error instanceof GenerateWordRequestError) {
        return failure(input.action, 'invalid_request', error.message)
      }
      return failure(
        input.action,
        'generation_failed',
        error instanceof Error ? error.message : 'Word generation failed.',
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

export function parseGenerateWordToolInput(
  value: unknown,
): GenerateWordToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  const allowed = new Set([
    'action',
    'inputPath',
    'markdown',
    'outputPath',
    'profile',
    'tableOfContents',
    'renderMermaid',
  ])
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid()
  const action = input.action
  if (action !== 'list_profiles' && action !== 'generate') invalid()
  if (
    input.inputPath !== undefined && typeof input.inputPath !== 'string' ||
    input.markdown !== undefined && typeof input.markdown !== 'string' ||
    input.outputPath !== undefined && typeof input.outputPath !== 'string' ||
    input.profile !== undefined && typeof input.profile !== 'string' ||
    input.tableOfContents !== undefined && typeof input.tableOfContents !== 'boolean' ||
    input.renderMermaid !== undefined && typeof input.renderMermaid !== 'boolean'
  ) invalid()
  if (action === 'generate') {
    const inputPath = input.inputPath
    const markdown = input.markdown
    const hasInputPath = typeof inputPath === 'string' && Boolean(inputPath.trim())
    const hasMarkdown = typeof markdown === 'string' && Boolean(markdown.trim())
    if (
      hasInputPath === hasMarkdown ||
      (typeof inputPath === 'string' && inputPath.length > 512) ||
      (typeof markdown === 'string' && Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) ||
      typeof input.outputPath !== 'string' ||
      !input.outputPath.trim() ||
      input.outputPath.length > 512
    ) invalid()
  } else if (
    input.inputPath !== undefined ||
    input.markdown !== undefined ||
    input.outputPath !== undefined ||
    input.profile !== undefined ||
    input.tableOfContents !== undefined ||
    input.renderMermaid !== undefined
  ) {
    invalid()
  }
  return {
    action,
    ...whenDefined(input.inputPath as string | undefined, (inputPath) => ({ inputPath })),
    ...whenDefined(input.markdown as string | undefined, (markdown) => ({ markdown })),
    ...whenDefined(input.outputPath as string | undefined, (outputPath) => ({ outputPath })),
    ...whenDefined(input.profile as string | undefined, (profile) => ({ profile })),
    ...whenDefined(input.tableOfContents as boolean | undefined, (tableOfContents) => ({ tableOfContents })),
    ...whenDefined(input.renderMermaid as boolean | undefined, (renderMermaid) => ({ renderMermaid })),
  }
}

function replaceExtension(relativePath: string, extension: string): string {
  return `${relativePath.slice(0, -path.extname(relativePath).length)}${extension}`
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
  action: GenerateWordAction,
  code: NonNullable<GenerateWordToolOutput['error']>['code'],
  message: string,
): GenerateWordToolOutput {
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

function fallbackAction(value: unknown): GenerateWordAction {
  return value === 'list_profiles' ? value : 'generate'
}

class GenerateWordRequestError extends Error {
  constructor() {
    super('Generate Word request is invalid.')
    this.name = 'GenerateWordRequestError'
  }
}

function invalid(): never {
  throw new GenerateWordRequestError()
}
