/**
 * The identity of one update operation, as durable evidence records it.
 *
 * A receipt is evidence for exactly one operation. Binding it to the target
 * and the names involved is not enough: two proposals can name the same Agent,
 * the same revision, and the same skills while asking for different documents,
 * and two Team updates can add an Agent under the same name while describing a
 * different Agent. A retry that could not tell those apart would adopt work
 * authored for the other one and publish something nobody approved.
 *
 * The digest covers the complete persisted operation and nothing else. The job
 * is deliberately outside it: a retry of the same stored plan is a different
 * job, and the same work.
 */

import { createHash } from 'node:crypto'

import type { ResourceUpdateOperation } from '../../contracts/resource-architect.js'

/** `sha256:<hex>` over the operation, insensitive to key order. */
export function digestResourceUpdateOperation(
  operation: ResourceUpdateOperation,
): string {
  return `sha256:${
    createHash('sha256').update(canonicalize(operation), 'utf8').digest('hex')
  }`
}

/**
 * A canonical rendering, with object keys in sorted order.
 *
 * Array order is preserved, because it is meaningful: the skills of an
 * operation are published in the order they were proposed, and two orders are
 * two different sequences of writes. Object key order is not meaningful, so it
 * is removed rather than allowed to make one operation look like two.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    return `{${entries.join(',')}}`
  }
  // Strings, numbers, and booleans render as their JSON forms; `undefined`
  // never reaches here, because a key holding it was dropped above.
  return JSON.stringify(value) ?? 'null'
}
