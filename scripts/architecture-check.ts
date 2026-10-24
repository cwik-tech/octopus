import { whenDefined } from '../core/optional-properties.js'
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export type DependencyKind =
  | 'import'
  | 'import-type'
  | 're-export'
  | 'dynamic-import'

export interface DependencyEdge {
  source: string
  specifier: string
  target?: string
  kind: DependencyKind
  line: number
}

export interface ArchitectureViolation {
  rule: string
  source: string
  target: string
  specifier: string
  message: string
}

export interface ArchitectureCheckResult {
  edges: DependencyEdge[]
  violations: ArchitectureViolation[]
  allowedViolations: ArchitectureViolation[]
  staleKnownViolations: string[]
}

export interface ArchitectureCheckOptions {
  rootDir: string
  knownViolations?: readonly string[]
}

export const DEFAULT_KNOWN_VIOLATIONS = [] as const

const SOURCE_ROOTS = [
  'contracts',
  'core',
  'domains',
  'electron',
  'engines',
  'parsers',
  'providers',
  'scripts',
  'server',
  'services',
  'shared',
  'team-runtime',
  'tests',
  'ui/src',
  'workflows',
] as const

interface BackendLayerPolicy {
  readonly name: string
  readonly order: number
  readonly prefixes: readonly string[]
}

/**
 * Backend imports point down this list: a layer may import itself or a layer
 * with a lower order, but never one with a higher order. A path takes the tier
 * of its longest matching prefix, so the seven `domains/<name>/` entries below
 * override plain `domains/`. docs/Module-Ownership.md says what each folder
 * owns and why it sits where it does.
 */
export const BACKEND_LAYER_POLICY: readonly BackendLayerPolicy[] = [
  {
    name: 'core',
    order: 0,
    prefixes: ['core/'],
  },
  {
    name: 'runtime foundation',
    order: 1,
    prefixes: ['domains/runtime/'],
  },
  {
    name: 'parsers/providers',
    order: 2,
    prefixes: ['parsers/', 'providers/', 'domains/provider/'],
  },
  {
    name: 'domains',
    order: 3,
    prefixes: ['domains/'],
  },
  {
    name: 'engines/workflows',
    order: 4,
    prefixes: [
      'engines/',
      'workflows/',
      'domains/run-orchestrator/',
      'domains/workflow-generator/',
    ],
  },
  {
    name: 'sessions/services',
    order: 5,
    prefixes: [
      'services/',
      'domains/projects/',
      'domains/scheduling/',
      'domains/sessions/',
    ],
  },
  {
    name: 'entrypoints',
    order: 6,
    prefixes: ['server/', 'team-runtime/', 'electron/'],
  },
] as const

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.tests-dist',
  'coverage',
  'dist',
  'dist-electron',
  'node_modules',
  'release',
])

const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const
const RUNTIME_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'] as const
const BUILTIN_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

interface RawCapabilityExecutorPolicy {
  readonly target: string
  readonly methods: readonly string[]
}

interface RawCapabilityFunctionPolicy {
  readonly target: string
  readonly functions: readonly string[]
}

interface RawCapabilityInterfaceExecutorPolicy {
  readonly declarationTarget: string
  readonly interfaceName: string
  readonly method: string
  readonly rawTarget: string
}

interface RawCapabilityAllowance {
  readonly source: string
  readonly target: string
  readonly reason: string
}

interface RawCapabilityExecutionAllowance extends RawCapabilityAllowance {
  readonly members: readonly string[]
}

const RAW_CAPABILITY_EXECUTORS: readonly RawCapabilityExecutorPolicy[] = [
  {
    target: 'domains/browser/browser-manager.ts',
    methods: ['execute'],
  },
  {
    target: 'domains/mcp/mcp-client-manager.ts',
    methods: ['callTool'],
  },
  {
    target: 'services/browser-tool-service.ts',
    methods: ['execute', 'executeCapability'],
  },
  {
    target: 'services/generate-excel-tool-service.ts',
    methods: ['execute'],
  },
  {
    target: 'services/generate-word-tool-service.ts',
    methods: ['execute'],
  },
  {
    target: 'services/research-web-tool-service.ts',
    methods: ['execute'],
  },
  {
    target: 'services/skill-loader-service.ts',
    methods: ['execute'],
  },
  {
    target: 'services/youtube-tool-service.ts',
    methods: ['execute', 'executeCapability'],
  },
] as const

const RAW_CAPABILITY_FUNCTIONS: readonly RawCapabilityFunctionPolicy[] = [
  {
    target: 'domains/excel-generation/excel-profiles.ts',
    functions: ['listExcelProfiles'],
  },
  {
    target: 'domains/excel-generation/excel-templates.ts',
    functions: [
      'fillExcelTemplate',
      'listExcelTemplates',
      'loadExcelTemplate',
    ],
  },
  {
    target: 'domains/excel-generation/generate-excel.ts',
    functions: ['generateExcelBuffer'],
  },
  {
    target: 'domains/word-generation/generate-word.ts',
    functions: ['generateWordBuffer'],
  },
  {
    target: 'domains/word-generation/word-profiles.ts',
    functions: ['listWordProfiles'],
  },
] as const

const RAW_CAPABILITY_INTERFACE_EXECUTORS:
readonly RawCapabilityInterfaceExecutorPolicy[] = [
  {
    declarationTarget: 'services/research-web-capability-adapter.ts',
    interfaceName: 'ResearchWebCapabilityService',
    method: 'execute',
    rawTarget: 'services/research-web-tool-service.ts',
  },
  {
    declarationTarget: 'services/skill-loader-capability-adapter.ts',
    interfaceName: 'SkillLoaderCapabilityService',
    method: 'execute',
    rawTarget: 'services/skill-loader-service.ts',
  },
] as const

const PI_TOOL_DEFINITION_EXECUTION_TARGET =
  '@earendil-works/pi-coding-agent#ToolDefinition.execute'
const PI_TOOL_DEFINITION_DECLARATION_SEGMENT =
  'node_modules/@earendil-works/pi-coding-agent/'
const SKILL_DISPATCH_GATEWAY_DECLARATION_TARGET =
  'services/skill-loader-capability-adapter.ts'
const MCP_APPROVAL_COORDINATOR_TARGET =
  'domains/mcp/mcp-approval-coordinator.ts'
const DISPATCH_OWNED_APPROVAL_SERVICES = new Set([
  'services/browser-tool-service.ts',
  'services/youtube-tool-service.ts',
])
const EMBEDDED_APPROVAL_IDENTIFIERS = new Set([
  'McpApprovalCoordinator',
  'approvalCoordinator',
  'approvalWaitTimeoutMs',
  'requestApproval',
  'requestAuthenticatedApproval',
])

/**
 * Trusted owners permitted to cross from governance into one raw executor.
 * Each entry names one concrete dependency edge and why it cannot be moved
 * outside that owner.
 */
export const RAW_CAPABILITY_EXECUTION_ALLOWLIST: readonly RawCapabilityExecutionAllowance[] = [
  {
    source: 'scripts/generate-excel.ts',
    target: 'domains/excel-generation/generate-excel.ts',
    members: ['generateExcelBuffer'],
    reason: 'The explicit human CLI generates a workbook without entering an agent tool loop.',
  },
  {
    source: 'scripts/generate-excel.ts',
    target: 'domains/excel-generation/excel-profiles.ts',
    members: ['listExcelProfiles'],
    reason: 'The explicit human CLI lists its local workbook profiles.',
  },
  {
    source: 'scripts/generate-excel.ts',
    target: 'domains/excel-generation/excel-templates.ts',
    members: [
      'fillExcelTemplate',
      'listExcelTemplates',
      'loadExcelTemplate',
    ],
    reason: 'The explicit human CLI lists and fills its local workbook templates.',
  },
  {
    source: 'scripts/generate-word.ts',
    target: 'domains/word-generation/generate-word.ts',
    members: ['generateWordBuffer'],
    reason: 'The explicit human CLI generates a document without entering an agent tool loop.',
  },
  {
    source: 'scripts/generate-word.ts',
    target: 'domains/word-generation/word-profiles.ts',
    members: ['listWordProfiles'],
    reason: 'The explicit human CLI lists its local document profiles.',
  },
  {
    source: 'team-runtime/capability-tool-adapter.ts',
    target: PI_TOOL_DEFINITION_EXECUTION_TARGET,
    members: ['execute'],
    reason: 'The sole Team Runtime raw-tool owner revalidates arguments and dispatches before invocation.',
  },
  {
    source: 'engines/pipeline.ts',
    target: PI_TOOL_DEFINITION_EXECUTION_TARGET,
    members: ['execute'],
    reason: 'The governed Pipeline tool owns its bounded single-task execution sub-operation.',
  },
  {
    source: 'domains/mcp/mcp-parent-broker.ts',
    target: 'domains/mcp/mcp-client-manager.ts',
    members: ['callTool'],
    reason: 'The MCP broker is the source-specific governed owner of raw transport calls.',
  },
  {
    source: 'server/voice-control/voice-layer-link.ts',
    target: 'domains/mcp/mcp-client-manager.ts',
    members: ['callTool'],
    reason:
      'Octopus calls only the enrolled voice layer\'s fixed set_status, notify and say tools with arguments it builds itself; no agent chooses these calls (docs/adr/2026-10-09-Voice-Control-Through-MCP.md).',
  },
  {
    source: 'services/browser-capability-adapter.ts',
    target: 'services/browser-tool-service.ts',
    members: ['executeCapability'],
    reason: 'The fixed Browser adapter invokes only the prepared raw executor.',
  },
  {
    source: 'services/browser-tool-service.ts',
    target: 'domains/browser/browser-manager.ts',
    members: ['execute'],
    reason: 'The Browser domain service owns raw managed-browser execution.',
  },
  {
    source: 'services/generate-excel-capability-adapter.ts',
    target: 'services/generate-excel-tool-service.ts',
    members: ['execute'],
    reason: 'The fixed Excel adapter validates and projects raw generator results.',
  },
  {
    source: 'services/generate-word-capability-adapter.ts',
    target: 'services/generate-word-tool-service.ts',
    members: ['execute'],
    reason: 'The fixed Word adapter validates and projects raw generator results.',
  },
  {
    source: 'services/research-web-capability-adapter.ts',
    target: 'services/research-web-tool-service.ts',
    members: ['execute'],
    reason: 'The fixed Research Web adapter owns raw acquisition execution.',
  },
  {
    source: 'services/skill-loader-capability-adapter.ts',
    target: 'services/skill-loader-service.ts',
    members: ['execute'],
    reason: 'The fixed skill adapter owns hash-validated raw skill loading.',
  },
  {
    source: 'services/youtube-capability-adapter.ts',
    target: 'services/youtube-tool-service.ts',
    members: ['executeCapability'],
    reason: 'The fixed YouTube adapter invokes only the prepared raw executor.',
  },
  {
    source: 'services/generate-excel-tool-service.ts',
    target: 'domains/excel-generation/generate-excel.ts',
    members: ['generateExcelBuffer'],
    reason: 'The governed Excel service owns workbook buffer generation and artifact publication.',
  },
  {
    source: 'services/generate-excel-tool-service.ts',
    target: 'domains/excel-generation/excel-profiles.ts',
    members: ['listExcelProfiles'],
    reason: 'The governed Excel service owns the read-only profile-list capability result.',
  },
  {
    source: 'services/generate-excel-tool-service.ts',
    target: 'domains/excel-generation/excel-templates.ts',
    members: [
      'fillExcelTemplate',
      'listExcelTemplates',
      'loadExcelTemplate',
    ],
    reason: 'The governed Excel service owns template listing, loading, and filling.',
  },
  {
    source: 'services/generate-word-tool-service.ts',
    target: 'domains/word-generation/generate-word.ts',
    members: ['generateWordBuffer'],
    reason: 'The governed Word service owns document buffer generation and artifact publication.',
  },
  {
    source: 'services/canvas-word-snapshot-service.ts',
    target: 'domains/word-generation/generate-word.ts',
    members: ['generateWordBuffer'],
    reason: 'The explicit human Canvas action captures saved Markdown and bounded private assets, fixes generation options, and publishes only to its session-owned binary store.',
  },
  {
    source: 'services/generate-word-tool-service.ts',
    target: 'domains/word-generation/word-profiles.ts',
    members: ['listWordProfiles'],
    reason: 'The governed Word service owns the read-only profile-list capability result.',
  },
  {
    source: 'services/agent-reply-service.ts',
    target: 'domains/excel-generation/generate-excel.ts',
    members: ['generateExcelBuffer'],
    reason: 'Confirmed deterministic chat publication generates the accepted workbook artifact.',
  },
  {
    source: 'domains/youtube/youtube-manual-service.ts',
    target: 'domains/word-generation/generate-word.ts',
    members: ['generateWordBuffer'],
    reason: 'The governed YouTube execution owns its manual publication sub-operation.',
  },
  {
    source: 'workflows/markdown-to-docx.ts',
    target: 'domains/word-generation/generate-word.ts',
    members: ['generateWordBuffer'],
    reason: 'The compatibility workflow transform returns an in-memory publication buffer.',
  },
  {
    source: 'workflows/runner.ts',
    target: 'domains/excel-generation/generate-excel.ts',
    members: ['generateExcelBuffer'],
    reason: 'The governed workflow transform owns its declared workbook publication step.',
  },
  {
    source: 'workflows/runner.ts',
    target: 'domains/excel-generation/excel-templates.ts',
    members: ['fillExcelTemplate', 'loadExcelTemplate'],
    reason: 'The governed workflow transform owns its declared template-fill publication step.',
  },
  {
    source: 'workflows/runner.ts',
    target: 'domains/word-generation/generate-word.ts',
    members: ['generateWordBuffer'],
    reason: 'The governed workflow transform owns its declared document publication step.',
  },
] as const

/** Runtime imports needed only to construct fixed services or parse requests. */
export const RAW_CAPABILITY_DEPENDENCY_ALLOWLIST: readonly RawCapabilityAllowance[] = [
  {
    source: 'server/routes/research-web-tool.ts',
    target: 'services/research-web-tool-service.ts',
    reason: 'The route reuses the pure request parser and invokes only its dispatch gateway.',
  },
  {
    source: 'server/tools/browser.ts',
    target: 'services/browser-tool-service.ts',
    reason: 'The fixed registry constructs the service but exposes only its dispatch gateway.',
  },
  {
    source: 'server/tools/generate-excel.ts',
    target: 'services/generate-excel-tool-service.ts',
    reason: 'The fixed registry constructs the service but exposes only its dispatch gateway.',
  },
  {
    source: 'server/tools/generate-word.ts',
    target: 'services/generate-word-tool-service.ts',
    reason: 'The fixed registry constructs the service but exposes only its dispatch gateway.',
  },
  {
    source: 'server/tools/research-web.ts',
    target: 'services/research-web-tool-service.ts',
    reason: 'The fixed registry constructs the service but exposes only its dispatch gateway.',
  },
  {
    source: 'server/tools/skill-loader.ts',
    target: 'services/skill-loader-service.ts',
    reason: 'The fixed registry constructs the service but exposes only its dispatch gateway.',
  },
  {
    source: 'server/tools/youtube.ts',
    target: 'services/youtube-tool-service.ts',
    reason: 'The fixed registry constructs the service but exposes only its dispatch gateway.',
  },
] as const

function toProjectPath(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join('/')
}

function collectTypeScriptFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const files: string[] = []
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          visit(path.join(current, entry.name))
        }
        continue
      }
      if (
        entry.isFile() &&
        TYPESCRIPT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
      ) {
        files.push(path.join(current, entry.name))
      }
    }
  }
  visit(directory)
  return files
}

function candidateSourcePaths(candidate: string): string[] {
  const extension = path.extname(candidate)
  const withoutRuntimeExtension = RUNTIME_EXTENSIONS.includes(
    extension as (typeof RUNTIME_EXTENSIONS)[number],
  )
    ? candidate.slice(0, -extension.length)
    : candidate
  const candidates = [candidate]
  for (const sourceExtension of TYPESCRIPT_EXTENSIONS) {
    candidates.push(`${withoutRuntimeExtension}${sourceExtension}`)
  }
  for (const sourceExtension of TYPESCRIPT_EXTENSIONS) {
    candidates.push(path.join(candidate, `index${sourceExtension}`))
  }
  return [...new Set(candidates)]
}

function resolveExistingProjectPath(rootDir: string, candidate: string): string {
  for (const sourcePath of candidateSourcePaths(candidate)) {
    if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
      return toProjectPath(rootDir, sourcePath)
    }
  }

  const extension = path.extname(candidate)
  const normalizedCandidate = RUNTIME_EXTENSIONS.includes(
    extension as (typeof RUNTIME_EXTENSIONS)[number],
  )
    ? `${candidate.slice(0, -extension.length)}.ts`
    : candidate
  return toProjectPath(rootDir, normalizedCandidate)
}

function resolveProjectTarget(
  rootDir: string,
  sourcePath: string,
  specifier: string,
): string | undefined {
  let candidate: string | undefined
  if (specifier.startsWith('.')) {
    candidate = path.resolve(rootDir, path.dirname(sourcePath), specifier)
  } else if (specifier === '@contracts' || specifier.startsWith('@contracts/')) {
    const suffix = specifier === '@contracts' ? 'index' : specifier.slice(11)
    candidate = path.resolve(rootDir, 'contracts', suffix)
  } else if (specifier === '@' || specifier.startsWith('@/')) {
    const suffix = specifier === '@' ? 'index' : specifier.slice(2)
    candidate = path.resolve(rootDir, 'ui/src', suffix)
  }
  if (!candidate) return undefined
  return resolveExistingProjectPath(rootDir, candidate)
}

function dependencyKindForImport(node: ts.ImportDeclaration): DependencyKind {
  return node.importClause?.isTypeOnly ? 'import-type' : 'import'
}

function sourceLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

export function collectDependencyEdges(
  rootDir: string,
  absoluteSourcePath: string,
): DependencyEdge[] {
  const sourcePath = toProjectPath(rootDir, absoluteSourcePath)
  const sourceText = fs.readFileSync(absoluteSourcePath, 'utf8')
  const scriptKind = absoluteSourcePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    absoluteSourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const edges: DependencyEdge[] = []

  const addEdge = (
    specifierNode: ts.StringLiteralLike,
    kind: DependencyKind,
  ): void => {
    const specifier = specifierNode.text
    edges.push({
      source: sourcePath,
      specifier,
      ...whenDefined(resolveProjectTarget(rootDir, sourcePath, specifier), (target) => ({ target: target })),
      kind,
      line: sourceLine(sourceFile, specifierNode),
    })
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      addEdge(statement.moduleSpecifier, dependencyKindForImport(statement))
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      addEdge(statement.moduleSpecifier, 're-export')
    }
  }

  const visitDynamicImports = (node: ts.Node): void => {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      addEdge(node.argument.literal, 'import-type')
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const importPath = node.arguments[0]
      if (importPath && ts.isStringLiteralLike(importPath)) {
        addEdge(importPath, 'dynamic-import')
      }
    }
    ts.forEachChild(node, visitDynamicImports)
  }
  visitDynamicImports(sourceFile)
  return edges
}

interface CapabilityMemberReference {
  readonly receiver: ts.Expression
  readonly name: string
  readonly nameNode: ts.Node
}

function capabilityMemberReference(
  node: ts.Node,
): CapabilityMemberReference | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return {
      receiver: node.expression,
      name: node.name.text,
      nameNode: node.name,
    }
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return {
      receiver: node.expression,
      name: node.argumentExpression.text,
      nameNode: node.argumentExpression,
    }
  }
  return undefined
}

function capabilityMemberDeclarations(input: {
  readonly checker: ts.TypeChecker
  readonly reference: CapabilityMemberReference
}): readonly ts.Declaration[] {
  const directSymbol = input.checker.getSymbolAtLocation(input.reference.nameNode)
  const receiverType = input.checker.getTypeAtLocation(input.reference.receiver)
  const propertySymbol = input.checker.getPropertyOfType(
    receiverType,
    input.reference.name,
  )
  return [
    ...(directSymbol?.declarations ?? []),
    ...(propertySymbol?.declarations ?? []),
  ]
}

function rawCapabilityDeclarationTarget(input: {
  readonly checker: ts.TypeChecker
  readonly rootDir: string
  readonly reference: CapabilityMemberReference
}): string | undefined {
  for (const declaration of capabilityMemberDeclarations(input)) {
    const target = toProjectPath(
      input.rootDir,
      declaration.getSourceFile().fileName,
    )
    const interfacePolicy = RAW_CAPABILITY_INTERFACE_EXECUTORS.find(
      (candidate) =>
        candidate.declarationTarget === target &&
        candidate.interfaceName === enclosingInterfaceName(declaration) &&
        candidate.method === input.reference.name,
    )
    if (interfacePolicy) return interfacePolicy.rawTarget
    const policy = RAW_CAPABILITY_EXECUTORS.find(
      (candidate) => candidate.target === target,
    )
    if (policy?.methods.includes(input.reference.name)) return target
    const functionPolicy = RAW_CAPABILITY_FUNCTIONS.find(
      (candidate) => candidate.target === target,
    )
    if (functionPolicy?.functions.includes(input.reference.name)) return target
  }
  return undefined
}

function enclosingInterfaceName(
  declaration: ts.Declaration,
): string | undefined {
  let current: ts.Node | undefined = declaration
  while (current) {
    if (ts.isInterfaceDeclaration(current)) return current.name.text
    current = current.parent
  }
  return undefined
}

function isPiToolDefinitionExecution(input: {
  readonly checker: ts.TypeChecker
  readonly rootDir: string
  readonly reference: CapabilityMemberReference
}): boolean {
  if (input.reference.name !== 'execute') return false
  return capabilityMemberDeclarations(input).some(
    (declaration) => {
      const declarationTarget = toProjectPath(
        input.rootDir,
        declaration.getSourceFile().fileName,
      )
      return declarationTarget.includes(PI_TOOL_DEFINITION_DECLARATION_SEGMENT) &&
        enclosingInterfaceName(declaration) === 'ToolDefinition'
    },
  )
}

function isSkillDispatchGatewayExecution(input: {
  readonly checker: ts.TypeChecker
  readonly rootDir: string
  readonly reference: CapabilityMemberReference
}): boolean {
  if (input.reference.name !== 'execute') return false
  return capabilityMemberDeclarations(input).some(
    (declaration) =>
      toProjectPath(input.rootDir, declaration.getSourceFile().fileName) ===
        SKILL_DISPATCH_GATEWAY_DECLARATION_TARGET &&
      enclosingInterfaceName(declaration) ===
        'SkillLoaderCapabilityDispatchInvoker',
  )
}

interface RawCapabilityFunctionReference {
  readonly name: string
  readonly target: string
}

function isImportedOrExportedBinding(node: ts.Identifier): boolean {
  const parent = node.parent
  return ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
}

function rawCapabilityFunctionReference(input: {
  readonly checker: ts.TypeChecker
  readonly rootDir: string
  readonly identifier: ts.Identifier
}): RawCapabilityFunctionReference | undefined {
  if (isImportedOrExportedBinding(input.identifier)) return undefined
  const directSymbol = input.checker.getSymbolAtLocation(input.identifier)
  if (!directSymbol) return undefined
  const symbol = (directSymbol.flags & ts.SymbolFlags.Alias) !== 0
    ? input.checker.getAliasedSymbol(directSymbol)
    : directSymbol
  const name = symbol.getName()
  for (const declaration of symbol.declarations ?? []) {
    const target = toProjectPath(
      input.rootDir,
      declaration.getSourceFile().fileName,
    )
    const policy = RAW_CAPABILITY_FUNCTIONS.find(
      (candidate) => candidate.target === target,
    )
    if (policy?.functions.includes(name)) return { name, target }
  }
  return undefined
}

function collectRawCapabilityExecutionViolations(
  rootDir: string,
  absoluteSourcePaths: readonly string[],
): ArchitectureViolation[] {
  const program = ts.createProgram({
    rootNames: [...absoluteSourcePaths],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      noEmit: true,
    },
  })
  const checker = program.getTypeChecker()
  const violations: ArchitectureViolation[] = []
  const violationKeys = new Set<string>()
  const usedExecutionAllowances = new Set<string>()
  const checkedSources = new Set(
    absoluteSourcePaths.map((sourcePath) => toProjectPath(rootDir, sourcePath)),
  )
  for (const absoluteSourcePath of absoluteSourcePaths) {
    const source = toProjectPath(rootDir, absoluteSourcePath)
    if (source.startsWith('tests/')) continue
    const sourceFile = program.getSourceFile(absoluteSourcePath)
    if (!sourceFile) continue
    const recordViolation = (target: string, specifier: string): void => {
      if (source === target) return
      if (
        hasRawCapabilityExecutionAllowance(
          RAW_CAPABILITY_EXECUTION_ALLOWLIST,
          source,
          target,
          specifier,
        )
      ) {
        usedExecutionAllowances.add(
          rawCapabilityExecutionAllowanceKey(source, target, specifier),
        )
        return
      }
      const key = `${source}\0${target}\0${specifier}`
      if (violationKeys.has(key)) return
      violationKeys.add(key)
      violations.push({
        rule: 'raw-capability-execution',
        source,
        target,
        specifier,
        message:
          'Raw capability execution is restricted to its fixed trusted adapter or domain owner.',
      })
    }
    const visit = (node: ts.Node): void => {
      const reference = capabilityMemberReference(node)
      if (reference) {
        const isUnresolvedTeamRuntimeExecute =
          source.startsWith('team-runtime/') &&
          reference.name === 'execute' &&
          !isSkillDispatchGatewayExecution({ checker, rootDir, reference })
        if (
          isUnresolvedTeamRuntimeExecute ||
          isPiToolDefinitionExecution({ checker, rootDir, reference })
        ) {
          recordViolation(PI_TOOL_DEFINITION_EXECUTION_TARGET, reference.name)
        }
        const target = rawCapabilityDeclarationTarget({
          checker,
          rootDir,
          reference,
        })
        if (target) recordViolation(target, reference.name)
      }
      if (ts.isIdentifier(node)) {
        const functionReference = rawCapabilityFunctionReference({
          checker,
          rootDir,
          identifier: node,
        })
        if (functionReference) {
          recordViolation(functionReference.target, functionReference.name)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  for (const allowance of RAW_CAPABILITY_EXECUTION_ALLOWLIST) {
    if (
      !checkedSources.has(allowance.source) ||
      (allowance.target !== PI_TOOL_DEFINITION_EXECUTION_TARGET &&
        !checkedSources.has(allowance.target))
    ) {
      continue
    }
    for (const member of allowance.members) {
      const key = rawCapabilityExecutionAllowanceKey(
        allowance.source,
        allowance.target,
        member,
      )
      if (usedExecutionAllowances.has(key)) continue
      violations.push({
        rule: 'stale-raw-capability-execution-allowance',
        source: allowance.source,
        target: allowance.target,
        specifier: member,
        message:
          'Remove the raw capability execution allowance because its exact call no longer exists.',
      })
    }
  }
  return violations
}

function collectEmbeddedApprovalOwnerViolations(
  rootDir: string,
  absoluteSourcePaths: readonly string[],
): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []
  for (const absoluteSourcePath of absoluteSourcePaths) {
    const source = toProjectPath(rootDir, absoluteSourcePath)
    if (!DISPATCH_OWNED_APPROVAL_SERVICES.has(source)) continue
    const sourceFile = ts.createSourceFile(
      absoluteSourcePath,
      fs.readFileSync(absoluteSourcePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    let forbiddenIdentifier: string | undefined
    const visit = (node: ts.Node): void => {
      if (forbiddenIdentifier) return
      if (
        ts.isIdentifier(node) &&
        EMBEDDED_APPROVAL_IDENTIFIERS.has(node.text)
      ) {
        forbiddenIdentifier = node.text
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (!forbiddenIdentifier) continue
    violations.push({
      rule: 'embedded-capability-approval-owner',
      source,
      target: MCP_APPROVAL_COORDINATOR_TARGET,
      specifier: forbiddenIdentifier,
      message:
        'Interactive capability approval is owned by the shared dispatcher, not a domain service.',
    })
  }
  return violations
}

function sourceRoot(projectPath: string): string {
  if (projectPath.startsWith('ui/src/')) return 'ui'
  return projectPath.split('/')[0] ?? projectPath
}

/**
 * Canonical execution-journal authority (Phase 8 ADR §9): the authoritative
 * capability/engine evidence facts live in the execution journal, and the
 * legacy JSONL evidence files are derived projections. Every other write is a
 * bypass of that authority.
 *
 * Two kinds of entry sit here, and they are not the same thing. Most are
 * **compatibility writers** that still write those files directly while their
 * producers migrate onto the journal, and each is expected to disappear. One
 * is the **sanctioned handoff**: a source that names the evidence path and
 * gives it to the canonical projection, which the rule now counts as a write
 * because it follows the path constant to its sink rather than requiring the
 * write verb in the same file (AC20). That entry is not a migration debt, and
 * removing it would not be progress — it records where the canonical route
 * begins. Each `reason` says which kind it is.
 */
export interface AuthoritativeEvidenceWriteAllowance {
  readonly source: string
  readonly reason: string
}

export const AUTHORITATIVE_EVIDENCE_WRITE_ALLOWLIST: readonly AuthoritativeEvidenceWriteAllowance[] =
  [
    {
      source: 'domains/runtime/capability-evidence-writer.ts',
      reason:
        'Compatibility writer for capability evidence; retired as every dispatch path moves onto the canonical execution journal projection (Phase 8 J4-J6).',
    },
    {
      source: 'services/workspace-execution-journal-registry.ts',
      reason:
        'Names the evidence path and hands it to the canonical execution journal projection, which is the sanctioned writer; it performs no write of its own. Listed because the rule now follows the path constant to its sink (AC20).',
    },
    {
      source: 'domains/runtime/runtime-events.ts',
      reason:
        'Compatibility engine-event writer; engine streams migrate onto the canonical execution journal in Phase 8 J5-J6.',
    },
    {
      source: 'domains/runtime/logger.ts',
      reason:
        'Initializes the compatibility engine-event log files; retired alongside runtime-events.ts in Phase 8 J5-J6.',
    },
  ]

const AUTHORITATIVE_EVIDENCE_FILE_MARKERS = [
  'capability-dispatch-events.jsonl',
  'engine-events.jsonl',
] as const

const EVIDENCE_WRITE_VERB_PATTERN =
  /appendFile|appendFileSync|createWriteStream|O_APPEND|writeFile|writeFileSync|\.write\(/

/**
 * Named channels that carry an evidence path to something that writes it.
 *
 * A writer does not have to hold the `write` itself. The canonical projection
 * assembles the path in one file and writes it in a generic store, so neither
 * source contains both the marker and a write verb, and the file-level match
 * saw no writer at all (AC20).
 *
 * Handing a marker-derived path to one of these is the same commitment as
 * writing it, so it counts the same. Each entry is a real option name, not a
 * pattern: the point is a short list that has to be extended deliberately.
 */
const EVIDENCE_SINK_CHANNELS = ['capabilityEvidenceProjectionPath'] as const

/**
 * Both evidence rules are decided from the same fact — whether a source still
 * writes an authoritative evidence file — so they share one pass over the
 * sources rather than each reading every file.
 *
 * The test is a file-level heuristic (marker filename plus a write verb
 * anywhere in the file). It is deliberately conservative: it can flag a file
 * that only mentions a marker in prose, and it cannot see a filename assembled
 * at runtime. It governs a shrinking allowlist during the migration, not
 * arbitrary code.
 */
function collectAuthoritativeEvidenceViolations(
  rootDir: string,
  absoluteSourcePaths: readonly string[],
): ArchitectureViolation[] {
  const allowlisted = new Set(
    AUTHORITATIVE_EVIDENCE_WRITE_ALLOWLIST.map((allowance) => allowance.source),
  )
  const violations: ArchitectureViolation[] = []
  const writingAllowlistedSources = new Set<string>()

  for (const absoluteSourcePath of absoluteSourcePaths) {
    const source = toProjectPath(rootDir, absoluteSourcePath)
    const isAllowlisted = allowlisted.has(source)
    // Production producers only: scripts/tests legitimately read or fixture
    // the evidence files without owning authoritative writes.
    const isProductionProducer = !(
      source.startsWith('tests/') ||
      source.startsWith('ui/') ||
      source.startsWith('scripts/')
    )
    if (!isAllowlisted && !isProductionProducer) continue

    const content = fs.readFileSync(absoluteSourcePath, 'utf8')
    const marker = AUTHORITATIVE_EVIDENCE_FILE_MARKERS.find((candidate) =>
      content.includes(candidate),
    )
    const writesEvidence =
      marker !== undefined &&
      (EVIDENCE_WRITE_VERB_PATTERN.test(content) ||
        EVIDENCE_SINK_CHANNELS.some((channel) => content.includes(channel)))

    if (isAllowlisted) {
      if (writesEvidence) writingAllowlistedSources.add(source)
      continue
    }
    if (!writesEvidence) continue
    violations.push({
      rule: 'authoritative-evidence-write-bypass',
      source,
      target: marker,
      specifier: 'authoritative-write',
      message:
        'Authoritative execution evidence must be written by the canonical execution journal projection, not by an independent writer.',
    })
  }

  const knownSources = new Set(
    absoluteSourcePaths.map((absoluteSourcePath) =>
      toProjectPath(rootDir, absoluteSourcePath),
    ),
  )
  for (const allowance of AUTHORITATIVE_EVIDENCE_WRITE_ALLOWLIST) {
    if (!knownSources.has(allowance.source)) continue
    if (writingAllowlistedSources.has(allowance.source)) continue
    violations.push({
      rule: 'stale-authoritative-evidence-write-allowance',
      source: allowance.source,
      target: AUTHORITATIVE_EVIDENCE_FILE_MARKERS[0] ?? 'evidence.jsonl',
      specifier: 'authoritative-write',
      message:
        'This compatibility evidence writer no longer writes authoritative evidence; remove its allowlist entry.',
    })
  }
  return violations
}

function backendLayer(
  projectPath: string,
): { readonly name: string; readonly order: number } | undefined {
  let matched:
    | {
        readonly name: string
        readonly order: number
        readonly prefixLength: number
      }
    | undefined
  for (const layer of BACKEND_LAYER_POLICY) {
    for (const prefix of layer.prefixes) {
      if (
        projectPath.startsWith(prefix) &&
        (!matched || prefix.length > matched.prefixLength)
      ) {
        matched = {
          name: layer.name,
          order: layer.order,
          prefixLength: prefix.length,
        }
      }
    }
  }
  return matched
}

function createViolation(
  edge: DependencyEdge,
  rule: string,
  message: string,
): ArchitectureViolation {
  return {
    rule,
    source: edge.source,
    target: edge.target ?? edge.specifier,
    specifier: edge.specifier,
    message,
  }
}

function isRawCapabilityTarget(target: string): boolean {
  return RAW_CAPABILITY_EXECUTORS.some((policy) => policy.target === target) ||
    RAW_CAPABILITY_FUNCTIONS.some((policy) => policy.target === target)
}

function isModelFacingCapabilitySource(source: string): boolean {
  return source.startsWith('server/tools/') ||
    source.startsWith('server/routes/') ||
    source.startsWith('team-runtime/') ||
    source.startsWith('engines/') ||
    source === 'services/mcp-agent-tool-service.ts' ||
    source === 'services/provider-capability-gateway.ts' ||
    /^domains\/.+-tool\.ts$/.test(source)
}

function hasRawCapabilityAllowance(
  allowances: readonly RawCapabilityAllowance[],
  source: string,
  target: string,
): boolean {
  return allowances.some(
    (allowance) => allowance.source === source && allowance.target === target,
  )
}

function hasRawCapabilityExecutionAllowance(
  allowances: readonly RawCapabilityExecutionAllowance[],
  source: string,
  target: string,
  member: string,
): boolean {
  return allowances.some(
    (allowance) =>
      allowance.source === source &&
      allowance.target === target &&
      allowance.members.includes(member),
  )
}

function rawCapabilityExecutionAllowanceKey(
  source: string,
  target: string,
  member: string,
): string {
  return `${source}\0${target}\0${member}`
}

function collectStaleRawCapabilityDependencyAllowances(
  rootDir: string,
  absoluteSourcePaths: readonly string[],
  edges: readonly DependencyEdge[],
): ArchitectureViolation[] {
  const checkedSources = new Set(
    absoluteSourcePaths.map((sourcePath) => toProjectPath(rootDir, sourcePath)),
  )
  const violations: ArchitectureViolation[] = []
  for (const allowance of RAW_CAPABILITY_DEPENDENCY_ALLOWLIST) {
    if (
      !checkedSources.has(allowance.source) ||
      !checkedSources.has(allowance.target)
    ) {
      continue
    }
    const hasRuntimeDependency = edges.some(
      (edge) =>
        edge.source === allowance.source &&
        edge.target === allowance.target &&
        edge.kind !== 'import-type',
    )
    if (hasRuntimeDependency) continue
    violations.push({
      rule: 'stale-raw-capability-dependency-allowance',
      source: allowance.source,
      target: allowance.target,
      specifier: allowance.target,
      message:
        'Remove the raw capability dependency allowance because its exact import no longer exists.',
    })
  }
  return violations
}

function evaluateEdge(edge: DependencyEdge): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []
  const source = edge.source
  const target = edge.target

  if (
    target &&
    edge.kind !== 'import-type' &&
    isModelFacingCapabilitySource(source) &&
    isRawCapabilityTarget(target) &&
    !hasRawCapabilityAllowance(
      RAW_CAPABILITY_DEPENDENCY_ALLOWLIST,
      source,
      target,
    )
  ) {
    violations.push(
      createViolation(
        edge,
        'raw-capability-dependency',
        'Model-facing code may depend on a dispatch gateway, not a raw capability executor.',
      ),
    )
  }

  if (
    source.startsWith('ui/src/') &&
    target &&
    !target.startsWith('ui/') &&
    !target.startsWith('contracts/')
  ) {
    violations.push(
      createViolation(
        edge,
        'ui-boundary',
        'UI source may import only UI modules and the contracts layer.',
      ),
    )
  }

  if (source.startsWith('contracts/')) {
    if (
      target
      && !target.startsWith('contracts/')
      && target !== 'core/optional-properties.ts'
    ) {
      violations.push(
        createViolation(
          edge,
          'contracts-leaf',
          'Contracts may import only other contracts, Zod, and Node built-ins.',
        ),
      )
    } else if (
      !target &&
      !edge.specifier.startsWith('.') &&
      edge.specifier !== 'zod' &&
      edge.specifier !== 'zod/v4' &&
      !BUILTIN_SPECIFIERS.has(edge.specifier)
    ) {
      violations.push(
        createViolation(
          edge,
          'contracts-leaf',
          'Contracts may import only other contracts, Zod, and Node built-ins.',
        ),
      )
    }
  }

  // shared/ held only forwarding files during the domain migration. It is
  // gone; nothing may import it and nothing may be added under it.
  if (source.startsWith('shared/') || target?.startsWith('shared/')) {
    violations.push(
      createViolation(
        edge,
        'retired-shared-path',
        'shared/ was retired; import the owning module directly.',
      ),
    )
  }

  if (target?.startsWith('server/')) {
    const allowedServerImporters = new Set([
      'electron',
      'scripts',
      'server',
      'team-runtime',
      'tests',
    ])
    if (!allowedServerImporters.has(sourceRoot(source))) {
      violations.push(
        createViolation(
          edge,
          'server-entrypoint',
          'Server modules may be imported only by entrypoints, scripts, and tests.',
        ),
      )
    }
  }

  if (
    source.startsWith('core/') &&
    target &&
    !target.startsWith('core/') &&
    !target.startsWith('contracts/')
  ) {
    violations.push(
      createViolation(
        edge,
        'core-leaf',
        'Core may import only core modules, leaf contracts, external packages, and Node built-ins.',
      ),
    )
  }

  if (target) {
    const sourceLayer = backendLayer(source)
    const targetLayer = backendLayer(target)
    if (
      sourceLayer &&
      targetLayer &&
      sourceLayer.order < targetLayer.order
    ) {
      violations.push(
        createViolation(
          edge,
          'backend-layer-order',
          `The ${sourceLayer.name} layer may not import the higher ` +
          `${targetLayer.name} layer.`,
        ),
      )
    }
  }

  return violations
}

function violationKey(violation: ArchitectureViolation): string {
  return `${violation.source} -> ${violation.target}`
}

export function checkArchitecture(
  options: ArchitectureCheckOptions,
): ArchitectureCheckResult {
  const rootDir = path.resolve(options.rootDir)
  const knownViolations = new Set(options.knownViolations ?? DEFAULT_KNOWN_VIOLATIONS)
  const sourceFiles = SOURCE_ROOTS.flatMap((sourceRootPath) =>
    collectTypeScriptFiles(path.join(rootDir, sourceRootPath)),
  )
  const edges = sourceFiles.flatMap((sourcePath) =>
    collectDependencyEdges(rootDir, sourcePath),
  )
  const evaluated = [
    ...edges.flatMap(evaluateEdge),
    ...collectEmbeddedApprovalOwnerViolations(rootDir, sourceFiles),
    ...collectRawCapabilityExecutionViolations(rootDir, sourceFiles),
    ...collectStaleRawCapabilityDependencyAllowances(
      rootDir,
      sourceFiles,
      edges,
    ),
    ...collectAuthoritativeEvidenceViolations(rootDir, sourceFiles),
  ]
  const seenKnownViolations = new Set<string>()
  const violations: ArchitectureViolation[] = []
  const allowedViolations: ArchitectureViolation[] = []

  for (const violation of evaluated) {
    const key = violationKey(violation)
    if (knownViolations.has(key)) {
      seenKnownViolations.add(key)
      allowedViolations.push(violation)
    } else {
      violations.push(violation)
    }
  }

  return {
    edges,
    violations,
    allowedViolations,
    staleKnownViolations: [...knownViolations].filter(
      (knownViolation) => !seenKnownViolations.has(knownViolation),
    ),
  }
}

export function formatArchitectureCheck(result: ArchitectureCheckResult): string {
  const lines: string[] = []
  for (const violation of result.violations) {
    lines.push(
      `[architecture:${violation.rule}] ${violation.source} -> ${violation.target} ` +
      `(import ${JSON.stringify(violation.specifier)}): ${violation.message}`,
    )
  }
  for (const staleViolation of result.staleKnownViolations) {
    lines.push(
      `[architecture:stale-allowlist] ${staleViolation}: remove the resolved exception.`,
    )
  }
  if (lines.length === 0) {
    lines.push(
      `[architecture] passed: ${result.edges.length} dependency edges checked; ` +
      `${result.allowedViolations.length} known violation(s) ratcheted.`,
    )
  }
  return lines.join('\n')
}

function runCli(): void {
  const currentFile = fileURLToPath(import.meta.url)
  const rootDir = path.resolve(path.dirname(currentFile), '..')
  const result = checkArchitecture({ rootDir })
  const output = formatArchitectureCheck(result)
  const failed =
    result.violations.length > 0 || result.staleKnownViolations.length > 0
  ;(failed ? console.error : console.log)(output)
  if (failed) process.exitCode = 1
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli()
}
