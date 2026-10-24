/**
 * Walks a filesystem path and returns the Agent Architect skill-source tree.
 *
 * A folder is a "skill leaf" when it directly contains a `SKILL.md` file.
 * Intermediate folders (those that contain only further subfolders, no
 * SKILL.md) are returned as display-only branches so the UI can render the
 * source hierarchy intact (e.g. "1. Technical Phase" → individual skills).
 *
 * The walk is bounded by `MAX_DEPTH` and skips dotfiles, `node_modules`, and
 * common archive folders (`old/`, `archive/`).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SkillTreeNode } from './types.js'

const MAX_DEPTH = 6
const SKIPPED_NAMES = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  'old',
  'archive',
  '_archive',
])

export function listSkillsTree(rootPath: string): SkillTreeNode | null {
  const absRoot = path.resolve(rootPath)
  if (!fs.existsSync(absRoot)) return null
  const stat = fs.statSync(absRoot)
  if (!stat.isDirectory()) return null
  return walk(absRoot, 0)
}

function walk(currentPath: string, depth: number): SkillTreeNode | null {
  const label = path.basename(currentPath)
  if (SKIPPED_NAMES.has(label) || label.startsWith('.')) return null

  const isSkill = fs.existsSync(path.join(currentPath, 'SKILL.md'))
  if (isSkill) {
    return { label, path: currentPath, isSkill: true }
  }

  if (depth >= MAX_DEPTH) return null

  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true })
  } catch {
    return null
  }

  const children: SkillTreeNode[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = walk(path.join(currentPath, entry.name), depth + 1)
    if (child) children.push(child)
  }
  if (children.length === 0) return null

  children.sort((a, b) => a.label.localeCompare(b.label))
  return { label, path: currentPath, isSkill: false, children }
}
