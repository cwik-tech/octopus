import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { z } from 'zod'

import { serialCapabilityEffect } from '../contracts/capability-effect.js'
import type { CapabilityAdapter } from '../contracts/capability-dispatch.js'
import { toMcpJsonObject } from '../contracts/mcp.js'
import { artifactMediaTypeForExtension } from '../core/artifact-media.js'
import { CapabilityDispatchRejection, type CapabilityDispatcher } from '../core/capability-dispatcher.js'
import { isSafePathSegment } from '../core/path-safety.js'
import { buildSessionRunAssignmentLocation } from '../core/run-assignment-location.js'
import type { BuiltinAgentToolAdapter, BuiltinToolExecutionInput } from '../domains/mcp/builtin-agent-tool-adapter.js'
import { publishRuntimeArtifactWrittenEvent } from '../domains/runtime/artifacts.js'
import { toBuiltinCapabilityExecutionContext } from './builtin-capability-context.js'

const createFileInputSchema = z.strictObject({
  filename: z.string().min(1).max(200).regex(/^[^.\/\\\x00-\x1f][^\/\\\x00-\x1f]*\.(md|markdown|txt|csv|tsv|json|yaml|yml|xml|html|css|js|ts|py|sh|sql|log|ini|toml|svg|tex|rst)$/i),
  content: z.string().max(2_000_000),
})

const artifactSchema = z.strictObject({
  path: z.string(),
  title: z.string(),
  mediaType: z.string(),
  role: z.literal('final'),
  // Previously accepted results remain replayable; every new write emits it.
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).transform(({ digest, ...artifact }) => ({ ...artifact, ...(digest === undefined ? {} : { digest }) }))
const createdFileSchema = z.strictObject({
  ok: z.literal(true),
  artifact: artifactSchema,
  sizeBytes: z.number().int().nonnegative(),
})

/** Baseline artifact creation; persona grants still govern Word and Excel. */
export function createFileTool(options: {
  workspacePath: string
  dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
}): BuiltinAgentToolAdapter {
  return {
    name: 'create_file',
    tool: {
      serverId: 'pipeline-files', serverName: 'Pipeline Files',
      toolName: 'create_file', namespacedName: 'create_file',
      description: 'Create and attach a downloadable UTF-8 text file, including Markdown, plain text, CSV, JSON, YAML, XML, HTML or source code. Supply a filename and the exact complete content; empty content is allowed. Files stay in the current assignment. Existing files are never overwritten; choose a new filename for revisions. Use Generate Word for DOCX and Generate Excel for XLSX.',
      inputSchema: toMcpJsonObject(z.toJSONSchema(createFileInputSchema)),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      risk: 'mutating', effect: serialCapabilityEffect('mutating'), requiresApproval: false,
    },
    isEnabledForAgent: () => true,
    async execute(input) {
      const result = await options.dispatcher.dispatch({
        context: toBuiltinCapabilityExecutionContext(input.context, { kind: 'mcp-lease', leaseId: input.context.leaseId }),
        invocation: {
          capabilityId: 'file.create', source: { kind: 'builtin', id: 'pipeline-files', version: '1' },
          toolCallId: input.toolCallId, input: input.input,
        },
        adapter: fileCapabilityAdapter(options.workspacePath, input.context),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      if (result.status === 'completed') {
        const output = createdFileSchema.parse(result.value)
        return { output, content: JSON.stringify(output), isError: false, artifacts: [output.artifact] }
      }
      const output = {
        ok: false,
        code: result.status === 'rejected' ? result.code : result.status,
        message: 'File creation did not complete. Check the filename and assignment; existing files cannot be replaced.',
      }
      return { output, content: JSON.stringify(output), isError: true }
    },
  }
}

function fileCapabilityAdapter(
  workspacePath: string,
  context: BuiltinToolExecutionInput['context'],
): CapabilityAdapter {
  return {
    capabilityId: 'file.create',
    async prepare({ arguments: rawInput }) {
      const parsed = createFileInputSchema.safeParse(rawInput)
      if (!parsed.success || !isSafePathSegment(parsed.data.filename)) {
        throw new CapabilityDispatchRejection('invalid_file_request')
      }
      return {
        effect: serialCapabilityEffect('mutating'), risk: 'mutating',
        argumentNames: ['content', 'filename'], policyDecision: { kind: 'allow' },
        authorize: async () => ({ kind: 'allow' }),
        execute: ({ signal }) => writeFileArtifact(workspacePath, context, parsed.data, signal),
        acceptResult: async ({ value }) => ({ value: createdFileSchema.parse(value) }),
      }
    },
  }
}

async function writeFileArtifact(
  workspacePath: string,
  context: BuiltinToolExecutionInput['context'],
  input: z.infer<typeof createFileInputSchema>,
  signal: AbortSignal,
): Promise<z.infer<typeof createdFileSchema>> {
  signal.throwIfAborted()
  const location = buildSessionRunAssignmentLocation(workspacePath, context)
  if (!location) throw new Error('Invalid file assignment scope.')
  const workspaceReal = await fs.realpath(workspacePath)
  const assignmentPath = path.resolve(location.assignmentPath)
  await requireExactDirectory(assignmentPath)
  if (!assignmentPath.startsWith(`${workspaceReal}${path.sep}`)) {
    throw new Error('File assignment is outside the workspace.')
  }
  const filesPath = path.join(assignmentPath, 'files')
  await fs.mkdir(filesPath, { recursive: true })
  await requireExactDirectory(filesPath)
  signal.throwIfAborted()
  const target = path.join(filesPath, input.filename)
  // Exclusive creation rejects existing files, hard links, and symlinks.
  const handle = await fs.open(target, 'wx', 0o600)
  const bytes = Buffer.from(input.content, 'utf8')
  try {
    await handle.writeFile(bytes, { signal })
  } catch (error) {
    await fs.unlink(target)
    throw new Error('Writing the text artifact failed.', { cause: error })
  } finally {
    await handle.close()
  }
  const relativePath = `files/${input.filename}`
  publishRuntimeArtifactWrittenEvent({
    outputDir: assignmentPath, relativePath, artifactType: 'text-document', artifactRole: 'final',
    sessionId: context.assignmentId, rootSessionId: context.runId, title: input.filename,
  })
  const extension = path.extname(input.filename).toLowerCase()
  const mediaType = artifactMediaTypeForExtension(extension === '.markdown' ? '.md' : extension) ?? 'text/plain'
  return {
    ok: true,
    artifact: { path: relativePath, title: input.filename, mediaType, role: 'final', digest: createHash('sha256').update(bytes).digest('hex') },
    sizeBytes: bytes.byteLength,
  }
}

async function requireExactDirectory(directory: string): Promise<void> {
  const [real, stat] = await Promise.all([fs.realpath(directory), fs.lstat(directory)])
  if (real !== directory || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('File artifacts require a contained directory without symlinks.')
  }
}
