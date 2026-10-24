import { createHash } from 'node:crypto'
import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { hostAuditedParallelReadEffect } from '../contracts/capability-effect.js'
import { isPathInside } from '../core/path-safety.js'
import type {
  McpJsonObject,
  McpNamespacedTool,
} from '../domains/mcp/mcp-runtime.js'

export interface SkillLoaderServiceOptions {
  readonly repoRootPath: string
}

export type LoadSkillOutput =
  | {
      readonly ok: true
      readonly name: string
      readonly source: string
      readonly sha256: string
      readonly content: string
    }
  | {
      readonly ok: false
      readonly code: string
      readonly message: string
    }

export class SkillLoaderService {
  readonly tool: McpNamespacedTool = {
    serverId: 'pipeline-skills',
    serverName: 'Pipeline Skills',
    toolName: 'load_skill',
    namespacedName: 'mcp__pipeline_skills__load_skill',
    description: 'Load one discovered agent skill after verifying its SHA-256 provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Exact SKILL.md source path from the available-skills catalog.',
        },
        sha256: {
          type: 'string',
          description: 'Exact SHA-256 value from the available-skills catalog.',
        },
      },
      required: ['source', 'sha256'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    risk: 'read-only',
    // Host-audited parallel read (2026-08-15): skill loading is a single
    // stateless strategy — contained-path validation, realpath containment,
    // one immutable file read, and SHA-256 verification. The service holds
    // no mutable state, writes no gateway observation state, is not
    // budget-metered, and never reaches MCP transport. Content-addressed
    // verification makes concurrent loads of the same or distinct skills
    // produce identical outputs to sequential execution.
    effect: hostAuditedParallelReadEffect(),
    requiresApproval: false,
  }

  constructor(private readonly options: SkillLoaderServiceOptions) {}

  isEnabledForAgent(agentPath: string): boolean {
    const skillsRoot = this.skillsRootForAgent(agentPath)
    if (!skillsRoot) return false
    try {
      return fsSync.readdirSync(skillsRoot, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() &&
          fsSync.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')),
      )
    } catch {
      return false
    }
  }

  async execute(
    agentPath: string,
    input: McpJsonObject,
  ): Promise<LoadSkillOutput> {
    const requestedSource = input.source
    const requestedSha256 = input.sha256
    if (
      typeof requestedSource !== 'string' ||
      typeof requestedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(requestedSha256)
    ) {
      return failure('invalid_skill_request', 'Skill source and SHA-256 are required.')
    }

    const source = path.resolve(requestedSource)
    const agentsRoot = path.resolve(this.options.repoRootPath, 'agents')
    if (
      !isPathInside(agentsRoot, source) ||
      path.basename(source) !== 'SKILL.md' ||
      !source.split(path.sep).includes('skills')
    ) {
      return failure(
        'skill_source_not_allowed',
        'Skill source is outside the repository agent packages.',
      )
    }
    const agentSkillsRoot = this.skillsRootForAgent(agentPath)
    if (!agentSkillsRoot || !isPathInside(agentSkillsRoot, source)) {
      return failure(
        'skill_source_not_allowed',
        'Skill source is outside the current agent skill catalog.',
      )
    }

    let realAgentsRoot: string
    let realAgentSkillsRoot: string
    let realSource: string
    let content: string
    try {
      [realAgentsRoot, realAgentSkillsRoot, realSource, content] = await Promise.all([
        fs.realpath(agentsRoot),
        fs.realpath(agentSkillsRoot),
        fs.realpath(source),
        fs.readFile(source, 'utf-8'),
      ])
    } catch {
      return failure('skill_not_found', 'Selected skill is unavailable.')
    }
    if (!isPathInside(realAgentsRoot, realSource)) {
      return failure(
        'skill_source_not_allowed',
        'Skill source is outside the repository agent packages.',
      )
    }
    if (!isPathInside(realAgentSkillsRoot, realSource)) {
      return failure(
        'skill_source_not_allowed',
        'Skill source is outside the current agent skill catalog.',
      )
    }

    const sha256 = createHash('sha256').update(content).digest('hex')
    if (requestedSha256 !== sha256) {
      return failure(
        'skill_content_changed',
        'Selected skill changed after discovery; refresh the skill catalog before loading it.',
      )
    }

    return {
      ok: true,
      name: path.basename(path.dirname(realSource)),
      source,
      sha256,
      content,
    }
  }

  private skillsRootForAgent(agentPath: string): string | undefined {
    const agentsRoot = path.resolve(this.options.repoRootPath, 'agents')
    const agentRoot = path.resolve(this.options.repoRootPath, agentPath)
    if (!isPathInside(agentsRoot, agentRoot)) return undefined
    return path.join(agentRoot, 'skills')
  }
}

function failure(code: string, message: string): LoadSkillOutput {
  return { ok: false, code, message }
}
