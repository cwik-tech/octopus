import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import { parseWorkflowRegistry } from '../../workflows/loader.js'

export class WorkflowDeleteNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`Workflow not found: ${workflowId}`)
    this.name = 'WorkflowDeleteNotFoundError'
  }
}

export interface DeleteWorkflowResult {
  workflowId: string
  registryPath: string
  templatePath: string
  templateDeleted: boolean
}

export async function deleteWorkflow(params: {
  workflowId: string
  registryPath: string
}): Promise<DeleteWorkflowResult> {
  const registry = parseWorkflowRegistry(params.registryPath)
  const entry = registry.entries.find((item) => item.name === params.workflowId)
  if (!entry) {
    throw new WorkflowDeleteNotFoundError(params.workflowId)
  }

  const existing = await fs.readFile(params.registryPath, 'utf8')
  const next = stripRegistryEntry(existing, params.workflowId)
  await fs.writeFile(params.registryPath, ensureTrailingNewline(next), 'utf8')

  const registryDir = path.dirname(path.resolve(params.registryPath))
  const templatePath = path.resolve(entry.template_path)
  const canDeleteTemplate =
    templatePath !== path.resolve(params.registryPath) &&
    isPathInside(registryDir, templatePath) &&
    fsSync.existsSync(templatePath)

  let templateDeleted = false
  if (canDeleteTemplate) {
    await fs.unlink(templatePath)
    templateDeleted = true
  }

  return {
    workflowId: params.workflowId,
    registryPath: params.registryPath,
    templatePath,
    templateDeleted,
  }
}

function stripRegistryEntry(text: string, workflowId: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let skipping = false

  for (const line of lines) {
    if (skipping) {
      if (/^[A-Za-z0-9_-]+:/.test(line)) {
        skipping = false
        out.push(line)
      } else if (line === '' || /^\s/.test(line)) {
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

  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd()
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function ensureTrailingNewline(value: string): string {
  return value.length > 0 ? `${value}\n` : ''
}
