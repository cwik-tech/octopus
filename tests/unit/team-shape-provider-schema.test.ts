/**
 * The schema the model answers against, held to the schema the app validates
 * with.
 *
 * These are two different dialects for one contract. The domain schema is zod;
 * the provider schema is JSON Schema in the house style the rest of
 * `resource-architect-output-schema.ts` uses. Writing the second by hand is how
 * they drift, so it is generated from the first and only the dialect is
 * changed. This test is what makes that claim checkable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

import {
  teamShapeSchema,
  teamShapeProviderSchema,
} from '../../contracts/schemas/team-shape.js'

interface JsonSchemaBranch {
  type?: string
  properties?: Record<string, { const?: string; enum?: string[] }>
  required?: string[]
  additionalProperties?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function branches(schema: unknown): JsonSchemaBranch[] {
  assert.ok(isRecord(schema), JSON.stringify(schema))
  assert.ok(Array.isArray(schema.anyOf), JSON.stringify(schema))
  return schema.anyOf
}

test('the provider schema uses the dialect the rest of the output schema uses', () => {
  const schema = teamShapeProviderSchema()
  const serialized = JSON.stringify(schema)
  // `anyOf` and `oneOf` are equivalent for a union discriminated by `const`,
  // and the shipped output schema is `anyOf` throughout with no `oneOf`. Zod
  // emits `oneOf`, so the generated schema is transformed rather than trusted.
  assert.doesNotMatch(serialized, /oneOf/)
  assert.match(serialized, /anyOf/)
  // A provider schema is embedded in a larger document and carries no $schema.
  assert.equal(Object.hasOwn(schema, '$schema'), false, serialized)
})

test('the provider schema describes exactly the three shapes the app accepts', () => {
  const kinds = branches(teamShapeProviderSchema())
    .map((branch) => branch.properties?.kind?.const)
    .sort()
  assert.deepEqual(kinds, ['chain', 'discussion', 'review'])
})

test('every branch is strict: all keys required, nothing extra allowed', () => {
  for (const branch of branches(teamShapeProviderSchema())) {
    assert.equal(branch.type, 'object')
    assert.equal(branch.additionalProperties, false)
    const properties = Object.keys(branch.properties ?? {}).sort()
    assert.deepEqual([...(branch.required ?? [])].sort(), properties)
  }
})

// The point of generating: if someone adds a field to the zod schema, the
// provider schema gains it in the same commit. Comparing key sets is what
// makes a silent divergence impossible.
test('the provider branches carry exactly the keys the domain schema carries', () => {
  const generated = z.toJSONSchema(teamShapeSchema, { target: 'draft-7' })
  const domainKeys = (generated as { oneOf: JsonSchemaBranch[] }).oneOf
    .map((branch) => Object.keys(branch.properties ?? {}).sort().join(','))
    .sort()
  const providerKeys = branches(teamShapeProviderSchema())
    .map((branch) => Object.keys(branch.properties ?? {}).sort().join(','))
    .sort()
  assert.deepEqual(providerKeys, domainKeys)
})

test('the depth values the model may answer with are the ones the app maps', () => {
  for (const branch of branches(teamShapeProviderSchema())) {
    assert.deepEqual(branch.properties?.depth?.enum, ['quick', 'standard', 'thorough'])
  }
})

// A schema the model never sees proposes nothing. This is the join between the
// contract above and the document the Resource Architect actually sends.
test('the team proposal the model answers with carries a shape', async () => {
  const { RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA } = await import(
    '../../domains/resource-architect/resource-architect-output-schema.js'
  )
  const serialized = JSON.stringify(RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA)
  const document: Record<string, unknown> = JSON.parse(serialized)

  const teamBranch = findTeamBranch(document)
  const team = teamBranch.properties?.team as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined
  assert.ok(team, serialized)
  assert.ok(team.properties?.shape, 'the team plan schema has no `shape`')
  // Codex requires every declared property to be required; an optional field
  // survives as an explicit null variant, not by omission.
  assert.ok(team.required?.includes('shape'), JSON.stringify(team.required))

  const shape = team.properties.shape as { anyOf?: Array<Record<string, unknown>> }
  assert.ok(Array.isArray(shape.anyOf), JSON.stringify(shape))
  const kinds = shape.anyOf
    .map((branch) => {
      const properties = branch.properties as
        | Record<string, { const?: string }>
        | undefined
      return properties?.kind?.const ?? branch.type
    })
    .sort()
  // The three shapes, plus the null a team whose shape was not chosen carries.
  assert.deepEqual(kinds, ['chain', 'discussion', 'null', 'review'])
  // And no `oneOf` sneaks into the shipped document.
  assert.doesNotMatch(serialized, /oneOf/)
})

function findTeamBranch(document: Record<string, unknown>): {
  properties?: Record<string, unknown>
} {
  const found = JSON.stringify(document).includes('"team"')
  assert.ok(found, 'the output schema has no team proposal branch')
  const stack: unknown[] = [document]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    if (!isRecord(node)) continue
    const properties = node.properties
    if (isRecord(properties) && 'team' in properties && 'kind' in properties) {
      return { properties }
    }
    stack.push(...Object.values(node))
  }
  throw new Error('the output schema has no team proposal branch')
}
