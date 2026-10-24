/**
 * An owned process's ancestors, by the explicit lineage its intents record
 * (`docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md`,
 * sections 3 and 5). Assignment folders are siblings, so lineage is never
 * read from paths.
 */

import * as path from 'node:path'

import { DEFAULT_MAX_SPAWN_DEPTH } from '../constants.js'
import {
  intentRecordSchema,
  ownedProcessScopeFolders,
  readScopeRecord,
} from './owned-process-records.js'

export type AncestorWalk =
  | { readonly kind: 'walked'; readonly ancestors: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * The most intents a real chain holds: one per nesting level, plus a file
 * parser started by the deepest Team.
 */
const MAX_CHAIN_INTENTS = DEFAULT_MAX_SPAWN_DEPTH + 1

/**
 * The ancestors of `ownedProcessId`, nearest first, following each intent's
 * `parentOwnedProcessId` to a `null` parent.
 *
 * Fails, and never loops, when an intent on the chain (its own included) is
 * absent, unreadable or invalid, when an id repeats, or when the chain is
 * longer than any real one.
 */
export async function walkAncestors(scopePath: string, ownedProcessId: string): Promise<AncestorWalk> {
  const intents = ownedProcessScopeFolders(scopePath).intents
  const visited = new Set<string>()
  const ancestors: string[] = []
  let current = ownedProcessId
  for (;;) {
    if (visited.has(current)) {
      return { kind: 'failed', reason: `the lineage of ${ownedProcessId} repeats ${current}` }
    }
    if (visited.size >= MAX_CHAIN_INTENTS) {
      return { kind: 'failed', reason: `the lineage of ${ownedProcessId} is longer than ${MAX_CHAIN_INTENTS} intents` }
    }
    visited.add(current)
    const read = await readScopeRecord({
      target: path.join(intents, `${current}.json`),
      schema: intentRecordSchema,
      expectedOwnedProcessId: current,
    })
    if (read.kind === 'absent') {
      return { kind: 'failed', reason: `the lineage of ${ownedProcessId} names ${current}, which has no intent` }
    }
    if (read.kind === 'unreadable') return { kind: 'failed', reason: read.reason }
    const parent = read.record.parentOwnedProcessId
    if (parent === null) return { kind: 'walked', ancestors }
    ancestors.push(parent)
    current = parent
  }
}
