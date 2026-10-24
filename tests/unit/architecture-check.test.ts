import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  AUTHORITATIVE_EVIDENCE_WRITE_ALLOWLIST,
  checkArchitecture,
  collectDependencyEdges,
  RAW_CAPABILITY_DEPENDENCY_ALLOWLIST,
  RAW_CAPABILITY_EXECUTION_ALLOWLIST,
} from '../../scripts/architecture-check.js'

function createFixture(files: Record<string, string>): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-check-')),
  )
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content)
  }
  return root
}

test('architecture check collects static, type-only, re-export, and dynamic edges', () => {
  const root = createFixture({
    'shared/source.ts': [
      "import './static.js'",
      "import type { Shape } from './types.js'",
      "export { value } from './exported.js'",
      "export type InlineShape = import('./inline-types.js').InlineShape",
      "export async function load() { return import('./dynamic.js') }",
    ].join('\n'),
    'shared/static.ts': 'export const staticValue = true',
    'shared/types.ts': 'export interface Shape { value: string }',
    'shared/exported.ts': 'export const value = true',
    'shared/inline-types.ts': 'export interface InlineShape { value: string }',
    'shared/dynamic.ts': 'export const dynamicValue = true',
  })

  const edges = collectDependencyEdges(root, path.join(root, 'shared/source.ts'))
  assert.deepEqual(
    edges.map(({ kind, target }) => ({ kind, target })),
    [
      { kind: 'import', target: 'shared/static.ts' },
      { kind: 'import-type', target: 'shared/types.ts' },
      { kind: 're-export', target: 'shared/exported.ts' },
      { kind: 'import-type', target: 'shared/inline-types.ts' },
      { kind: 'dynamic-import', target: 'shared/dynamic.ts' },
    ],
  )
})

test('architecture check resolves UI and contracts aliases', () => {
  const root = createFixture({
    'ui/src/source.ts': [
      "import type { Contract } from '@contracts/wire.js'",
      "import { localValue } from '@/local.js'",
    ].join('\n'),
    'ui/src/local.ts': 'export const localValue = true',
    'contracts/wire.ts': 'export interface Contract { value: string }',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.equal(result.violations.length, 0)
  assert.deepEqual(
    result.edges.map((edge) => edge.target).sort(),
    ['contracts/wire.ts', 'ui/src/local.ts'],
  )
})

test('architecture check detects every governed import syntax', () => {
  const root = createFixture({
    'shared/source.ts': [
      "import '../server/static.js'",
      "import type { Shape } from '../server/types.js'",
      "export { value } from '../team-runtime/exported.js'",
      "export type InlineShape = import('../server/inline-types.js').InlineShape",
      "export async function load() { return import('../team-runtime/dynamic.js') }",
    ].join('\n'),
    'server/static.ts': 'export const staticValue = true',
    'server/types.ts': 'export interface Shape { value: string }',
    'server/inline-types.ts': 'export interface InlineShape { value: string }',
    'team-runtime/exported.ts': 'export const value = true',
    'team-runtime/dynamic.ts': 'export const dynamicValue = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'retired-shared-path')
      .map((violation) => violation.target)
      .sort(),
    [
      'server/inline-types.ts',
      'server/static.ts',
      'server/types.ts',
      'team-runtime/dynamic.ts',
      'team-runtime/exported.ts',
    ],
  )
})

test('nothing may import the retired shared path, and nothing there may import', () => {
  const root = createFixture({
    'domains/catalog/list.ts': "export { value } from '../../shared/facade.js'",
    'server/api.ts': "import { value } from '../shared/facade.js'; export { value }",
    'tests/unit/probe.ts': "import { value } from '../../shared/facade.js'; export { value }",
    'shared/facade.ts': "export { value } from '../core/value.js'",
    'core/value.ts': 'export const value = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'retired-shared-path')
      .map(({ source, target }) => ({ source, target })),
    [
      { source: 'domains/catalog/list.ts', target: 'shared/facade.ts' },
      { source: 'server/api.ts', target: 'shared/facade.ts' },
      { source: 'shared/facade.ts', target: 'core/value.ts' },
      { source: 'tests/unit/probe.ts', target: 'shared/facade.ts' },
    ],
  )
})

test('architecture check passes a clean layered fixture', () => {
  const root = createFixture({
    'core/value.ts': 'export const value = true',
    'core/source.ts': "import { value } from './value.js'; export { value }",
    'contracts/wire.ts': "import { z } from 'zod/v4'; export const Wire = z.string()",
    'server/api.ts': "import { value } from '../core/value.js'; export { value }",
    'team-runtime/main.ts': "import '../server/api.js'",
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.staleKnownViolations, [])
})

test('core may depend on leaf contracts without opening a higher-layer backedge', () => {
  const root = createFixture({
    'contracts/capability.ts': [
      "import { z } from 'zod/v4'",
      'export const CapabilityId = z.string()',
      'export type CapabilityId = z.infer<typeof CapabilityId>',
    ].join('\n'),
    'core/dispatcher.ts': [
      "import type { CapabilityId } from '../contracts/capability.js'",
      'export function dispatch(id: CapabilityId): CapabilityId { return id }',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(result.violations, [])
})

test('architecture check rejects an ungoverned model-facing raw capability execution', () => {
  const root = createFixture({
    'services/browser-tool-service.ts': [
      'export class BrowserToolService {',
      '  async execute(): Promise<string> { return "raw" }',
      '}',
    ].join('\n'),
    'server/tools/browser.ts': [
      "import { BrowserToolService } from '../../services/browser-tool-service.js'",
      'const service = new BrowserToolService()',
      'export const agentTool = {',
      '  execute: async () => service.execute(),',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'server/tools/browser.ts',
      target: 'services/browser-tool-service.ts',
      specifier: 'execute',
    }],
  )
})

test('architecture check permits only trusted adapter execution and human-only scripts', () => {
  const root = createFixture({
    'services/browser-tool-service.ts': [
      'export class BrowserToolService {',
      '  async executeCapability(): Promise<string> { return "raw" }',
      '}',
    ].join('\n'),
    'services/browser-capability-adapter.ts': [
      "import { BrowserToolService } from './browser-tool-service.js'",
      'export async function dispatch(service: BrowserToolService) {',
      '  return service.executeCapability()',
      '}',
    ].join('\n'),
    'domains/word-generation/generate-word.ts': [
      'export function generateWordBuffer(): Uint8Array {',
      '  return new Uint8Array()',
      '}',
    ].join('\n'),
    'scripts/generate-word.ts': [
      "import { generateWordBuffer } from '../domains/word-generation/generate-word.js'",
      'void generateWordBuffer()',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations.filter(
      (violation) => violation.rule === 'raw-capability-execution',
    ),
    [],
  )
})

test('architecture check rejects a trusted adapter calling an unapproved raw method', () => {
  const root = createFixture({
    'services/browser-tool-service.ts': [
      'export class BrowserToolService {',
      '  async execute(): Promise<string> { return "legacy" }',
      '  async executeCapability(): Promise<string> { return "prepared" }',
      '}',
    ].join('\n'),
    'services/browser-capability-adapter.ts': [
      "import { BrowserToolService } from './browser-tool-service.js'",
      'export async function dispatch(service: BrowserToolService) {',
      '  return service.execute()',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'services/browser-capability-adapter.ts',
      target: 'services/browser-tool-service.ts',
      specifier: 'execute',
    }],
  )
})

test('Browser and YouTube domain services cannot own interactive approval', () => {
  const root = createFixture({
    'domains/mcp/mcp-approval-coordinator.ts': [
      'export interface McpApprovalCoordinator {',
      '  requestApproval(): Promise<"approved" | "denied">',
      '}',
    ].join('\n'),
    'services/browser-tool-service.ts': [
      'interface EmbeddedApproval { requestApproval(): Promise<"approved" | "denied"> }',
      'export interface BrowserToolServiceOptions {',
      '  readonly approvalCoordinator?: EmbeddedApproval',
      '}',
      'export async function approve(options: BrowserToolServiceOptions) {',
      '  return options.approvalCoordinator?.requestApproval()',
      '}',
    ].join('\n'),
    'services/youtube-tool-service.ts': [
      "import type { McpApprovalCoordinator } from '../domains/mcp/mcp-approval-coordinator.js'",
      'export interface YoutubeToolServiceOptions {',
      "  readonly approvalCoordinator?: Pick<McpApprovalCoordinator, 'requestApproval'>",
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter(
        (violation) =>
          violation.rule === 'embedded-capability-approval-owner',
      )
      .map(({ source, target }) => ({ source, target }))
      .sort((left, right) => left.source.localeCompare(right.source)),
    [
      {
        source: 'services/browser-tool-service.ts',
        target: 'domains/mcp/mcp-approval-coordinator.ts',
      },
      {
        source: 'services/youtube-tool-service.ts',
        target: 'domains/mcp/mcp-approval-coordinator.ts',
      },
    ],
  )
})

test('architecture check follows a structural capability interface to its raw executor', () => {
  const root = createFixture({
    'services/research-web-tool-service.ts': [
      'export class ResearchWebToolService {',
      '  async execute(): Promise<string> { return "raw" }',
      '}',
    ].join('\n'),
    'services/research-web-capability-adapter.ts': [
      'export interface ResearchWebCapabilityService {',
      '  execute(): Promise<string>',
      '}',
    ].join('\n'),
    'server/tools/research-shortcut.ts': [
      "import type { ResearchWebCapabilityService } from '../../services/research-web-capability-adapter.js'",
      'export async function invoke(service: ResearchWebCapabilityService) {',
      '  return service.execute()',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'server/tools/research-shortcut.ts',
      target: 'services/research-web-tool-service.ts',
      specifier: 'execute',
    }],
  )
})

test('architecture check rejects raw execution from an unlisted script', () => {
  const root = createFixture({
    'services/browser-tool-service.ts': [
      'export class BrowserToolService {',
      '  async executeCapability(): Promise<string> { return "raw" }',
      '}',
    ].join('\n'),
    'scripts/run-browser-manually.ts': [
      "import { BrowserToolService } from '../services/browser-tool-service.js'",
      'const service = new BrowserToolService()',
      'void service.executeCapability()',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'scripts/run-browser-manually.ts',
      target: 'services/browser-tool-service.ts',
      specifier: 'executeCapability',
    }],
  )
})

test('architecture check rejects computed access to a raw capability function', () => {
  const root = createFixture({
    'domains/word-generation/generate-word.ts': [
      'export function generateWordBuffer(): Uint8Array {',
      '  return new Uint8Array()',
      '}',
    ].join('\n'),
    'scripts/run-word-shortcut.ts': [
      "import * as documentGenerator from '../domains/word-generation/generate-word.js'",
      "void documentGenerator['generateWordBuffer']()",
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'scripts/run-word-shortcut.ts',
      target: 'domains/word-generation/generate-word.ts',
      specifier: 'generateWordBuffer',
    }],
  )
})

test('architecture check rejects a model-facing import of a raw generator function', () => {
  const root = createFixture({
    'domains/word-generation/generate-word.ts': [
      'export function generateWordBuffer(): Uint8Array {',
      '  return new Uint8Array()',
      '}',
    ].join('\n'),
    'server/tools/generate-word.ts': [
      "import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'",
      'export const agentTool = { execute: () => generateWordBuffer() }',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'server/tools/generate-word.ts',
      target: 'domains/word-generation/generate-word.ts',
      specifier: 'generateWordBuffer',
    }],
  )
})

test('architecture check rejects an aliased raw generator function reference', () => {
  const root = createFixture({
    'domains/excel-generation/generate-excel.ts': [
      'export function generateExcelBuffer(): Uint8Array {',
      '  return new Uint8Array()',
      '}',
    ].join('\n'),
    'server/tools/generate-excel.ts': [
      "import { generateExcelBuffer } from '../../domains/excel-generation/generate-excel.js'",
      'const invokeWithoutDispatch = generateExcelBuffer',
      'export const agentTool = { execute: () => invokeWithoutDispatch() }',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'server/tools/generate-excel.ts',
      target: 'domains/excel-generation/generate-excel.ts',
      specifier: 'generateExcelBuffer',
    }],
  )
})

test('architecture check rejects raw read-only and mutating document primitives', () => {
  const root = createFixture({
    'domains/word-generation/word-profiles.ts': [
      'export function listWordProfiles(): readonly string[] { return [] }',
    ].join('\n'),
    'domains/excel-generation/excel-templates.ts': [
      'export async function fillExcelTemplate(): Promise<Uint8Array> {',
      '  return new Uint8Array()',
      '}',
    ].join('\n'),
    'server/tools/document-shortcut.ts': [
      "import { listWordProfiles } from '../../domains/word-generation/word-profiles.js'",
      "import { fillExcelTemplate } from '../../domains/excel-generation/excel-templates.js'",
      'export const agentTool = {',
      '  execute: async () => ({ profiles: listWordProfiles(), workbook: await fillExcelTemplate() }),',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [
      {
        source: 'server/tools/document-shortcut.ts',
        target: 'domains/word-generation/word-profiles.ts',
        specifier: 'listWordProfiles',
      },
      {
        source: 'server/tools/document-shortcut.ts',
        target: 'domains/excel-generation/excel-templates.ts',
        specifier: 'fillExcelTemplate',
      },
    ],
  )
})

test('architecture check rejects direct Team Runtime tool execution outside its governed adapter', () => {
  const root = createFixture({
    'node_modules/@earendil-works/pi-coding-agent/package.json': JSON.stringify({
      type: 'module',
      types: 'dist/core/extensions/types.d.ts',
    }),
    'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts': [
      'export interface ToolDefinition {',
      '  execute(): Promise<string>',
      '}',
    ].join('\n'),
    'team-runtime/index.ts': [
      "import type { ToolDefinition } from '@earendil-works/pi-coding-agent'",
      'declare const modelTool: ToolDefinition',
      'const invokeWithoutDispatch = modelTool.execute',
      'export async function runModelTool() {',
      '  return invokeWithoutDispatch()',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'team-runtime/index.ts',
      target: '@earendil-works/pi-coding-agent#ToolDefinition.execute',
      specifier: 'execute',
    }],
  )
})

test('architecture check fails closed on unresolved Team Runtime execute access', () => {
  const root = createFixture({
    'team-runtime/index.ts': [
      'declare const unresolvedTool: { readonly missingType: true }',
      'export async function runModelTool() {',
      '  return unresolvedTool.execute()',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'team-runtime/index.ts',
      target: '@earendil-works/pi-coding-agent#ToolDefinition.execute',
      specifier: 'execute',
    }],
  )
})

test('architecture check rejects direct Pi tool execution from any model-facing entrypoint', () => {
  const root = createFixture({
    'node_modules/@earendil-works/pi-coding-agent/package.json': JSON.stringify({
      type: 'module',
      types: 'dist/core/extensions/types.d.ts',
    }),
    'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts': [
      'export interface ToolDefinition {',
      '  execute(): Promise<string>',
      '}',
    ].join('\n'),
    'server/tools/direct-pi-tool.ts': [
      "import type { ToolDefinition } from '@earendil-works/pi-coding-agent'",
      'declare const modelTool: ToolDefinition',
      'export async function runModelTool() {',
      '  return modelTool.execute()',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'raw-capability-execution')
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'server/tools/direct-pi-tool.ts',
      target: '@earendil-works/pi-coding-agent#ToolDefinition.execute',
      specifier: 'execute',
    }],
  )
})

test('architecture check permits a Team Runtime governed dispatch gateway', () => {
  const root = createFixture({
    'services/skill-loader-capability-adapter.ts': [
      'export interface SkillLoaderCapabilityDispatchInvoker {',
      '  execute(): Promise<string>',
      '}',
    ].join('\n'),
    'team-runtime/standalone-skill-loader-tool.ts': [
      "import type { SkillLoaderCapabilityDispatchInvoker } from '../services/skill-loader-capability-adapter.js'",
      'export async function invoke(dispatcher: SkillLoaderCapabilityDispatchInvoker) {',
      '  return dispatcher.execute()',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations.filter(
      (violation) => violation.rule === 'raw-capability-execution',
    ),
    [],
  )
})

test('raw capability allowlists contain only exact explained entries', () => {
  const executionKeys = new Set<string>()
  for (const allowance of RAW_CAPABILITY_EXECUTION_ALLOWLIST) {
    assert.ok(allowance.reason.trim().length > 0)
    assert.ok(allowance.members.length > 0)
    assert.ok(!allowance.source.includes('*'))
    assert.ok(!allowance.target.includes('*'))
    assert.ok(allowance.members.every((member) => !member.includes('*')))
    const key = `${allowance.source}\0${allowance.target}`
    assert.ok(!executionKeys.has(key))
    executionKeys.add(key)
  }

  const dependencyKeys = new Set<string>()
  for (const allowance of RAW_CAPABILITY_DEPENDENCY_ALLOWLIST) {
    assert.ok(allowance.reason.trim().length > 0)
    assert.ok(!allowance.source.includes('*'))
    assert.ok(!allowance.target.includes('*'))
    const key = `${allowance.source}\0${allowance.target}`
    assert.ok(!dependencyKeys.has(key))
    dependencyKeys.add(key)
  }
})

test('architecture check rejects a stale raw execution allowance', () => {
  const root = createFixture({
    'services/browser-tool-service.ts': [
      'export class BrowserToolService {',
      '  async executeCapability(): Promise<string> { return "raw" }',
      '}',
    ].join('\n'),
    'services/browser-capability-adapter.ts': [
      'export const noRawExecution = true',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter(
        (violation) =>
          violation.rule === 'stale-raw-capability-execution-allowance',
      )
      .map(({ source, target, specifier }) => ({ source, target, specifier })),
    [{
      source: 'services/browser-capability-adapter.ts',
      target: 'services/browser-tool-service.ts',
      specifier: 'executeCapability',
    }],
  )
})

test('architecture check rejects a stale raw dependency allowance', () => {
  const root = createFixture({
    'services/browser-tool-service.ts': [
      'export class BrowserToolService {',
      '  async executeCapability(): Promise<string> { return "raw" }',
      '}',
    ].join('\n'),
    'server/tools/browser.ts': 'export const noRawDependency = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter(
        (violation) =>
          violation.rule === 'stale-raw-capability-dependency-allowance',
      )
      .map(({ source, target }) => ({ source, target })),
    [{
      source: 'server/tools/browser.ts',
      target: 'services/browser-tool-service.ts',
    }],
  )
})

test('contracts may share only the dependency-free optional-property constructor from core', () => {
  const root = createFixture({
    'core/optional-properties.ts': 'export function whenDefined() { return {} }',
    'core/other.ts': 'export const other = true',
    'contracts/allowed.ts': "import '../core/optional-properties.js'",
    'contracts/rejected.ts': "import '../core/other.js'",
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations.map(({ rule, source, target }) => ({ rule, source, target })),
    [{
      rule: 'contracts-leaf',
      source: 'contracts/rejected.ts',
      target: 'core/other.ts',
    }],
  )
})

test('architecture check rejects a lower backend layer importing a higher layer', () => {
  const root = createFixture({
    'parsers/source.ts': "import { value } from '../domains/catalog.js'; export { value }",
    'domains/catalog.ts': 'export const value = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations.map(({ rule, source, target }) => ({
      rule,
      source,
      target,
    })),
    [{
      rule: 'backend-layer-order',
      source: 'parsers/source.ts',
      target: 'domains/catalog.ts',
    }],
  )
})

test('architecture check allows backend layers to import downward', () => {
  const root = createFixture({
    'core/value.ts': 'export const value = true',
    'providers/client.ts': "import { value } from '../core/value.js'; export { value }",
    'parsers/source.ts': "import { value } from '../core/value.js'; export { value }",
    'domains/catalog.ts': [
      "import { value } from '../core/value.js'",
      "import { clientValue } from '../providers/feature-client.js'",
      'export { value, clientValue }',
    ].join('\n'),
    'providers/feature-client.ts': 'export const clientValue = true',
    'engines/runner.ts': "import { value } from '../domains/catalog.js'; export { value }",
    'workflows/flow.ts': "import { value } from '../domains/catalog.js'; export { value }",
    'domains/sessions/store.ts': [
      "import { run } from '../../engines/execution.js'",
      "import { value } from '../catalog.js'",
      'export { run, value }',
    ].join('\n'),
    'engines/execution.ts': 'export const run = true',
    'services/application.ts': [
      "import { store } from '../domains/sessions/facade.js'",
      "import { run } from '../engines/execution.js'",
      'export { store, run }',
    ].join('\n'),
    'domains/sessions/facade.ts': 'export const store = true',
    'server/api.ts': "import { run } from '../services/application.js'; export { run }",
    'team-runtime/main.ts': "import '../server/api.js'",
    'electron/main.ts': "import '../server/api.js'",
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
})

test('Projects orchestration may compose the session domain without becoming an entrypoint', () => {
  const root = createFixture({
    'domains/projects/workspace-project-service.ts': [
      "import { store } from '../sessions/session-store.js'",
      'export { store }',
    ].join('\n'),
    'domains/sessions/session-store.ts': 'export const store = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
})

test('Services import canonical lower owners and sibling services', () => {
  const root = createFixture({
    'contracts/service.ts': 'export interface ServiceWire { value: string }',
    'core/value.ts': 'export const coreValue = true',
    'domains/catalog.ts': 'export const domainValue = true',
    'parsers/input.ts': 'export const parserValue = true',
    'providers/client.ts': 'export const providerValue = true',
    'workflows/flow.ts': 'export const workflowValue = true',
    'services/sibling.ts': 'export const siblingValue = true',
    'services/application.ts': [
      "import type { ServiceWire } from '../contracts/service.js'",
      "import { coreValue } from '../core/value.js'",
      "import { domainValue } from '../domains/catalog.js'",
      "import { parserValue } from '../parsers/input.js'",
      "import { providerValue } from '../providers/client.js'",
      "import { workflowValue } from '../workflows/flow.js'",
      "import { siblingValue } from './sibling.js'",
      'export const result: ServiceWire = {',
      '  value: String(',
      '    coreValue && domainValue && parserValue && providerValue &&',
      '    workflowValue && siblingValue',
      '  ),',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
})

test('Services reject shared service and shared core facades', () => {
  const root = createFixture({
    'services/application.ts': [
      "import { legacyService } from '../shared/services/legacy.js'",
      "import { legacyCore } from '../shared/path-safety.js'",
      'export { legacyService, legacyCore }',
    ].join('\n'),
    'shared/services/legacy.ts': 'export const legacyService = true',
    'shared/path-safety.ts': 'export const legacyCore = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations.map(({ rule, source, target }) => ({
      rule,
      source,
      target,
    })),
    [
      {
        rule: 'retired-shared-path',
        source: 'services/application.ts',
        target: 'shared/services/legacy.ts',
      },
      {
        rule: 'retired-shared-path',
        source: 'services/application.ts',
        target: 'shared/path-safety.ts',
      },
    ],
  )
})

test('runtime foundation imports core downward and higher layers import runtime', () => {
  const root = createFixture({
    'core/value.ts': 'export const value = true',
    'contracts/runtime.ts': 'export interface RuntimeWire { value: string }',
    'domains/runtime/events.ts': [
      "import { value } from '../../core/value.js'",
      "import type { RuntimeWire } from '../../contracts/runtime.js'",
      'export const event: RuntimeWire = { value: String(value) }',
    ].join('\n'),
    'providers/client.ts': [
      "import { event } from '../domains/runtime/events.js'",
      'export { event }',
    ].join('\n'),
    'domains/catalog.ts': [
      "import { event } from './runtime/events.js'",
      'export { event }',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
})

test('runtime foundation cannot import adapters, ordinary domains, or shared facades', () => {
  const root = createFixture({
    'domains/runtime/source.ts': [
      "import { provider } from '../../providers/client.js'",
      "import { catalog } from '../catalog.js'",
      "import { facade } from '../../shared/facade.js'",
      'export { provider, catalog, facade }',
    ].join('\n'),
    'providers/client.ts': 'export const provider = true',
    'domains/catalog.ts': 'export const catalog = true',
    'shared/facade.ts': 'export const facade = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations
      .map(({ rule, target }) => ({ rule, target }))
      .sort((left, right) => left.target.localeCompare(right.target)),
    [
      {
        rule: 'backend-layer-order',
        target: 'domains/catalog.ts',
      },
      {
        rule: 'backend-layer-order',
        target: 'providers/client.ts',
      },
      {
        rule: 'retired-shared-path',
        target: 'shared/facade.ts',
      },
    ],
  )
})

test('provider domain imports contracts, core, runtime, provider adapters, and siblings', () => {
  const root = createFixture({
    'contracts/provider.ts': 'export interface ProviderWire { value: string }',
    'core/value.ts': 'export const value = true',
    'domains/runtime/events.ts': 'export const event = true',
    'providers/client.ts': 'export const client = true',
    'domains/provider/sibling.ts': 'export const sibling = true',
    'domains/provider/source.ts': [
      "import type { ProviderWire } from '../../contracts/provider.js'",
      "import { value } from '../../core/value.js'",
      "import { event } from '../runtime/events.js'",
      "import { client } from '../../providers/client.js'",
      "import { sibling } from './sibling.js'",
      'export const result: ProviderWire = { value: String(value && event && client && sibling) }',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
})

test('provider domain cannot import ordinary domains, engines, services, or shared facades', () => {
  const root = createFixture({
    'domains/provider/source.ts': [
      "import { catalog } from '../catalog.js'",
      "import { engine } from '../../engines/runner.js'",
      "import { service } from '../../services/application.js'",
      "import { facade } from '../../shared/facade.js'",
      'export { catalog, engine, service, facade }',
    ].join('\n'),
    'domains/catalog.ts': 'export const catalog = true',
    'engines/runner.ts': 'export const engine = true',
    'services/application.ts': 'export const service = true',
    'shared/facade.ts': 'export const facade = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations
      .map(({ rule, target }) => ({ rule, target }))
      .sort((left, right) => left.target.localeCompare(right.target)),
    [
      {
        rule: 'backend-layer-order',
        target: 'domains/catalog.ts',
      },
      {
        rule: 'backend-layer-order',
        target: 'engines/runner.ts',
      },
      {
        rule: 'backend-layer-order',
        target: 'services/application.ts',
      },
      {
        rule: 'retired-shared-path',
        target: 'shared/facade.ts',
      },
    ],
  )
})

test('Browser domain imports canonical lower layers and rejects shared facades', () => {
  const cleanRoot = createFixture({
    'contracts/browser.ts': 'export interface BrowserWire { value: string }',
    'core/value.ts': 'export const value = true',
    'domains/runtime/events.ts': 'export const event = true',
    'domains/browser/types.ts': 'export const browserType = true',
    'domains/browser/manager.ts': [
      "import type { BrowserWire } from '../../contracts/browser.js'",
      "import { value } from '../../core/value.js'",
      "import { event } from '../runtime/events.js'",
      "import { browserType } from './types.js'",
      'export const manager: BrowserWire = {',
      '  value: String(value && event && browserType),',
      '}',
    ].join('\n'),
  })

  const cleanResult = checkArchitecture({
    rootDir: cleanRoot,
    knownViolations: [],
  })
  assert.deepEqual(cleanResult.violations, [])

  const violatingRoot = createFixture({
    'domains/browser/manager.ts':
      "import { manager } from '../../shared/browser/manager.js'; export { manager }",
    'shared/browser/manager.ts': 'export const manager = true',
  })
  const violatingResult = checkArchitecture({
    rootDir: violatingRoot,
    knownViolations: [],
  })
  assert.deepEqual(
    violatingResult.violations.map(({ rule, source, target }) => ({
      rule,
      source,
      target,
    })),
    [{
      rule: 'retired-shared-path',
      source: 'domains/browser/manager.ts',
      target: 'shared/browser/manager.ts',
    }],
  )
})

test('Workflow Generator imports canonical lower owners and peer workflows', () => {
  const root = createFixture({
    'contracts/workflow-generator.ts':
      'export interface WorkflowGeneratorWire { value: string }',
    'core/value.ts': 'export const value = true',
    'providers/client.ts': 'export const provider = true',
    'domains/agent-generator/catalog.ts': 'export const catalog = true',
    'workflows/loader.ts': 'export const loader = true',
    'domains/workflow-generator/sibling.ts': 'export const sibling = true',
    'domains/workflow-generator/source.ts': [
      "import type { WorkflowGeneratorWire } from '../../contracts/workflow-generator.js'",
      "import { value } from '../../core/value.js'",
      "import { provider } from '../../providers/client.js'",
      "import { catalog } from '../agent-generator/catalog.js'",
      "import { loader } from '../../workflows/loader.js'",
      "import { sibling } from './sibling.js'",
      'export const result: WorkflowGeneratorWire = {',
      '  value: String(value && provider && catalog && loader && sibling),',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
})

test('Workflow Generator cannot import services or shared paths', () => {
  const root = createFixture({
    'domains/workflow-generator/source.ts': [
      "import { service } from '../../services/application.js'",
      "import { facade } from '../../shared/workflow-generator/facade.js'",
      'export { service, facade }',
    ].join('\n'),
    'services/application.ts': 'export const service = true',
    'shared/workflow-generator/facade.ts': 'export const facade = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations
      .map(({ rule, target }) => ({ rule, target }))
      .sort((left, right) => left.target.localeCompare(right.target)),
    [
      {
        rule: 'backend-layer-order',
        target: 'services/application.ts',
      },
      {
        rule: 'retired-shared-path',
        target: 'shared/workflow-generator/facade.ts',
      },
    ],
  )
})

test('MCP is an ordinary domain with canonical lower dependencies', () => {
  const root = createFixture({
    'contracts/mcp.ts': 'export interface McpWire { value: string }',
    'core/value.ts': 'export const value = true',
    'domains/runtime/events.ts': 'export const runtimeEvent = true',
    'domains/provider/client.ts': 'export const provider = true',
    'domains/run/store.ts': 'export const runStore = true',
    'domains/mcp/sibling.ts': 'export const sibling = true',
    'domains/mcp/source.ts': [
      "import type { McpWire } from '../../contracts/mcp.js'",
      "import { value } from '../../core/value.js'",
      "import { runtimeEvent } from '../runtime/events.js'",
      "import { provider } from '../provider/client.js'",
      "import { runStore } from '../run/store.js'",
      "import { sibling } from './sibling.js'",
      'export const result: McpWire = {',
      '  value: String(value && runtimeEvent && provider && runStore && sibling),',
      '}',
    ].join('\n'),
    'domains/catalog.ts':
      "import { result } from './mcp/source.js'; export { result }",
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
})

test('MCP rejects engine, service, session, and shared implementation backedges', () => {
  const root = createFixture({
    'domains/mcp/source.ts': [
      "import { engine } from '../../engines/runner.js'",
      "import { service } from '../../services/application.js'",
      "import { session } from '../sessions/store.js'",
      "import { facade } from '../../shared/services/facade.js'",
      'export { engine, service, session, facade }',
    ].join('\n'),
    'engines/runner.ts': 'export const engine = true',
    'services/application.ts': 'export const service = true',
    'domains/sessions/store.ts': 'export const session = true',
    'shared/services/facade.ts': 'export const facade = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations
      .map(({ rule, target }) => ({ rule, target }))
      .sort((left, right) => left.target.localeCompare(right.target)),
    [
      {
        rule: 'backend-layer-order',
        target: 'domains/sessions/store.ts',
      },
      {
        rule: 'backend-layer-order',
        target: 'engines/runner.ts',
      },
      {
        rule: 'backend-layer-order',
        target: 'services/application.ts',
      },
      {
        rule: 'retired-shared-path',
        target: 'shared/services/facade.ts',
      },
    ],
  )
})

test('Sessions domain imports canonical owners and rejects shared facades', () => {
  const cleanRoot = createFixture({
    'contracts/sessions.ts': 'export interface SessionWire { value: string }',
    'core/value.ts': 'export const value = true',
    'domains/runtime/events.ts': 'export const runtimeEvent = true',
    'domains/provider/client.ts': 'export const provider = true',
    'domains/run/store.ts': 'export const runStore = true',
    'workflows/loader.ts': 'export const workflow = true',
    'domains/sessions/sibling.ts': 'export const sibling = true',
    'domains/sessions/source.ts': [
      "import type { SessionWire } from '../../contracts/sessions.js'",
      "import { value } from '../../core/value.js'",
      "import { runtimeEvent } from '../runtime/events.js'",
      "import { provider } from '../provider/client.js'",
      "import { runStore } from '../run/store.js'",
      "import { workflow } from '../../workflows/loader.js'",
      "import { sibling } from './sibling.js'",
      'export const result: SessionWire = {',
      '  value: String(value && runtimeEvent && provider && runStore && workflow && sibling),',
      '}',
    ].join('\n'),
  })

  const cleanResult = checkArchitecture({
    rootDir: cleanRoot,
    knownViolations: [],
  })
  assert.deepEqual(cleanResult.violations, [])

  const violatingRoot = createFixture({
    'domains/sessions/store.ts':
      "import { store } from '../../shared/sessions/store.js'; export { store }",
    'shared/sessions/store.ts': 'export const store = true',
  })
  const violatingResult = checkArchitecture({
    rootDir: violatingRoot,
    knownViolations: [],
  })
  assert.deepEqual(
    violatingResult.violations.map(({ rule, source, target }) => ({
      rule,
      source,
      target,
    })),
    [{
      rule: 'retired-shared-path',
      source: 'domains/sessions/store.ts',
      target: 'shared/sessions/store.ts',
    }],
  )
})

test('Agent Execution is an ordinary domain with canonical lower and peer dependencies', () => {
  const root = createFixture({
    'contracts/execution.ts':
      'export interface ExecutionWire { value: string }',
    'core/value.ts': 'export const value = true',
    'domains/runtime/events.ts': 'export const runtimeEvent = true',
    'providers/client.ts': 'export const provider = true',
    'domains/provider/errors.ts': 'export const providerError = true',
    'domains/mcp/worker.ts': 'export const worker = true',
    'domains/run/location.ts': 'export const runLocation = true',
    'domains/stage/contracts.ts': 'export const stageContract = true',
    'domains/agent-execution/sibling.ts': 'export const sibling = true',
    'domains/agent-execution/runner.ts': [
      "import type { ExecutionWire } from '../../contracts/execution.js'",
      "import { value } from '../../core/value.js'",
      "import { runtimeEvent } from '../runtime/events.js'",
      "import { provider } from '../../providers/client.js'",
      "import { providerError } from '../provider/errors.js'",
      "import { worker } from '../mcp/worker.js'",
      "import { runLocation } from '../run/location.js'",
      "import { stageContract } from '../stage/contracts.js'",
      "import { sibling } from './sibling.js'",
      'export const result: ExecutionWire = {',
      '  value: String(',
      '    value && runtimeEvent && provider && providerError && worker &&',
      '    runLocation && stageContract && sibling',
      '  ),',
      '}',
    ].join('\n'),
    'engines/execution.ts':
      "import { result } from '../domains/agent-execution/runner.js'; export { result }",
    'workflows/runner.ts':
      "import { result } from '../domains/agent-execution/runner.js'; export { result }",
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(result.violations, [])
})

test('Agent Execution rejects higher layers and transitional shared paths', () => {
  const root = createFixture({
    'domains/agent-execution/runner.ts': [
      "import { engine } from '../../engines/runner.js'",
      "import { workflow } from '../../workflows/runner.js'",
      "import { service } from '../../services/application.js'",
      "import { session } from '../sessions/store.js'",
      "import { facade } from '../../shared/facade.js'",
      'export { engine, workflow, service, session, facade }',
    ].join('\n'),
    'engines/runner.ts': 'export const engine = true',
    'workflows/runner.ts': 'export const workflow = true',
    'services/application.ts': 'export const service = true',
    'domains/sessions/store.ts': 'export const session = true',
    'shared/facade.ts': 'export const facade = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations
      .map(({ rule, target }) => ({ rule, target }))
      .sort((left, right) => left.target.localeCompare(right.target)),
    [
      {
        rule: 'backend-layer-order',
        target: 'domains/sessions/store.ts',
      },
      {
        rule: 'backend-layer-order',
        target: 'engines/runner.ts',
      },
      {
        rule: 'backend-layer-order',
        target: 'services/application.ts',
      },
      {
        rule: 'retired-shared-path',
        target: 'shared/facade.ts',
      },
      {
        rule: 'backend-layer-order',
        target: 'workflows/runner.ts',
      },
    ],
  )
})

test('Deep Research domain imports canonical owners and rejects shared facades', () => {
  const cleanRoot = createFixture({
    'contracts/deep-research.ts':
      'export interface ResearchWire { value: string }',
    'core/value.ts': 'export const value = true',
    'domains/runtime/events.ts': 'export const event = true',
    'domains/browser/types.ts': 'export const browserType = true',
    'parsers/plan.ts': 'export const plan = true',
    'domains/deep-research/policy.ts': 'export const policy = true',
    'domains/deep-research/adapter.ts': [
      "import type { ResearchWire } from '../../contracts/deep-research.js'",
      "import { value } from '../../core/value.js'",
      "import { event } from '../runtime/events.js'",
      "import { browserType } from '../browser/types.js'",
      "import { plan } from '../../parsers/plan.js'",
      "import { policy } from './policy.js'",
      'export const adapter: ResearchWire = {',
      '  value: String(value && event && browserType && plan && policy),',
      '}',
    ].join('\n'),
  })

  const cleanResult = checkArchitecture({
    rootDir: cleanRoot,
    knownViolations: [],
  })
  assert.deepEqual(cleanResult.violations, [])

  const violatingRoot = createFixture({
    'domains/deep-research/adapter.ts':
      "import { adapter } from '../../shared/deep-research/adapter.js'; export { adapter }",
    'shared/deep-research/adapter.ts': 'export const adapter = true',
  })
  const violatingResult = checkArchitecture({
    rootDir: violatingRoot,
    knownViolations: [],
  })
  assert.deepEqual(
    violatingResult.violations.map(({ rule, source, target }) => ({
      rule,
      source,
      target,
    })),
    [{
      rule: 'retired-shared-path',
      source: 'domains/deep-research/adapter.ts',
      target: 'shared/deep-research/adapter.ts',
    }],
  )
})

test('architecture check uses the most-specific promoted domain layer', () => {
  const root = createFixture({
    'domains/catalog.ts': [
      "import { runStore } from './run/store.js'",
      "import { sessionStore } from './sessions/store.js'",
      'export { runStore, sessionStore }',
    ].join('\n'),
    'domains/run/store.ts': [
      "import { runtimeEvent } from '../runtime/events.js'",
      "import { execution } from '../../engines/execution.js'",
      'export const runStore = { runtimeEvent, execution }',
    ].join('\n'),
    'domains/runtime/events.ts': 'export const runtimeEvent = true',
    'domains/sessions/store.ts': 'export const sessionStore = true',
    'engines/execution.ts': 'export const execution = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations
      .filter((violation) => violation.rule === 'backend-layer-order')
      .map(({ source, target }) => ({ source, target })),
    [
      {
        source: 'domains/catalog.ts',
        target: 'domains/sessions/store.ts',
      },
      {
        source: 'domains/run/store.ts',
        target: 'engines/execution.ts',
      },
    ],
  )
})

test('all ordinary domains reject transitional shared facades', () => {
  const root = createFixture({
    'domains/catalog.ts':
      "import { legacy } from '../shared/legacy.js'; export { legacy }",
    'shared/legacy.ts': 'export const legacy = true',
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })
  assert.deepEqual(
    result.violations.map(({ rule, source, target }) => ({
      rule,
      source,
      target,
    })),
    [{
      rule: 'retired-shared-path',
      source: 'domains/catalog.ts',
      target: 'shared/legacy.ts',
    }],
  )
})

test('architecture allowlist ratchets exact edges and rejects stale entries', () => {
  const root = createFixture({
    'shared/source.ts': "import '../core/value.js'",
    'core/value.ts': 'export const value = true',
  })

  const allowed = checkArchitecture({
    rootDir: root,
    knownViolations: ['shared/source.ts -> core/value.ts'],
  })
  assert.equal(allowed.violations.length, 0)
  assert.equal(allowed.allowedViolations.length, 1)
  assert.deepEqual(allowed.staleKnownViolations, [])

  const stale = checkArchitecture({
    rootDir: root,
    knownViolations: ['shared/removed.ts -> core/value.ts'],
  })
  assert.equal(stale.violations.length, 1)
  assert.deepEqual(stale.staleKnownViolations, [
    'shared/removed.ts -> core/value.ts',
  ])
})

test('architecture check rejects an independent authoritative evidence writer', () => {
  const root = createFixture({
    'services/legacy-evidence-writer.ts': [
      "import { appendFileSync } from 'node:fs'",
      "const file = 'capability-dispatch-events.jsonl'",
      'export function write(record: unknown) {',
      '  appendFileSync(file, JSON.stringify(record))',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((v) => v.rule === 'authoritative-evidence-write-bypass')
      .map(({ source, target }) => ({ source, target })),
    [
      {
        source: 'services/legacy-evidence-writer.ts',
        target: 'capability-dispatch-events.jsonl',
      },
    ],
  )
})

/**
 * AC20: the gate has to see a writer that spans files.
 *
 * The rule matched a marker filename and a write verb in the *same* source.
 * The canonical projection is not built that way: the path constant lives in
 * the service that assembles it, the write lives in a generic projection
 * store, and neither file contains both. So the one writer that replaced the
 * legacy one was invisible to the check meant to govern exactly that set — and
 * so would any future writer built the same way.
 *
 * Handing a marker-derived path to a known evidence sink is what makes a file
 * a writer here, whether or not it does the `write` itself.
 */
test('architecture check follows an evidence path constant to its writer', () => {
  const root = createFixture({
    'services/evidence-path-owner.ts': [
      "import { createSink } from '../core/evidence-sink.js'",
      "const file = 'capability-dispatch-events.jsonl'",
      'export function build(assignmentPath: string) {',
      '  return createSink({ capabilityEvidenceProjectionPath: `${assignmentPath}/logs/${file}` })',
      '}',
    ].join('\n'),
    'core/evidence-sink.ts': [
      "import { open } from 'node:fs/promises'",
      'export function createSink(options: { capabilityEvidenceProjectionPath: string }) {',
      '  return async (line: string) => {',
      '    const handle = await open(options.capabilityEvidenceProjectionPath, "a")',
      '    await handle.writeFile(line)',
      '  }',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations
      .filter((v) => v.rule === 'authoritative-evidence-write-bypass')
      .map(({ source, target }) => ({ source, target })),
    [
      {
        source: 'services/evidence-path-owner.ts',
        target: 'capability-dispatch-events.jsonl',
      },
    ],
    'the file that names the evidence path and hands it to a sink is a writer',
  )
})

test('architecture check permits reading evidence files without writing them', () => {
  const root = createFixture({
    'services/evidence-reader.ts': [
      "import { readFileSync } from 'node:fs'",
      "const file = 'engine-events.jsonl'",
      'export function read(): string {',
      '  return readFileSync(file, "utf8")',
      '}',
    ].join('\n'),
  })

  const result = checkArchitecture({ rootDir: root, knownViolations: [] })

  assert.deepEqual(
    result.violations.filter(
      (v) => v.rule === 'authoritative-evidence-write-bypass',
    ),
    [],
  )
})

test('authoritative evidence write allowlist entries are exact and explained', () => {
  const seen = new Set<string>()
  for (const allowance of AUTHORITATIVE_EVIDENCE_WRITE_ALLOWLIST) {
    assert.ok(allowance.reason.trim().length > 0)
    assert.ok(!allowance.source.includes('*'))
    assert.ok(!seen.has(allowance.source))
    seen.add(allowance.source)
  }
})
