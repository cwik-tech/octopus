import { whenDefined } from '../core/optional-properties.js'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  serialCapabilityEffect,
  type CapabilityEffect,
} from '../contracts/capability-effect.js'
import { BrowserManager, BrowserRuntimeError } from '../domains/browser/browser-manager.js'
import {
  classifyBrowserAction,
  readBrowserAgentPolicy,
  resolveBrowserCapabilityEffect,
  type BrowserAgentPolicy,
  type BrowserActionRisk,
  type BrowserTargetDescription,
} from '../domains/browser/browser-policy.js'
import {
  BROWSER_SERVER_ID,
  BROWSER_TOOL_NAME,
  browserToolInputSchema,
  type BrowserAction,
  type BrowserAttachmentView,
  type BrowserErrorCode,
  type BrowserToolInput,
  type BrowserToolOutput,
} from '../domains/browser/browser-types.js'
import {
  isSupportedSourceObservationReceiptVersion,
  type SourceObservationReceiptView,
} from '../domains/acquisition/acquisition-types.js'
import { canonicalizeSourceUrl } from '../domains/acquisition/acquisition-url.js'
import { SourceObservationStore } from '../domains/acquisition/source-observation-store.js'
import {
  type McpBrokerRequestContext,
  type McpJsonObject,
  type McpNamespacedTool,
} from '../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../domains/run/run-location.js'
import { isSafePathSegment, resolveRelativePathInside } from '../core/path-safety.js'
import { MAX_BROWSER_ACTIVITY_PER_SESSION } from '../domains/browser/browser-types.js'

const MAX_ACTIVITY_PER_SESSION = MAX_BROWSER_ACTIVITY_PER_SESSION

export type BrowserActivityState =
  | 'requested'
  | 'awaiting-approval'
  | 'running'
  | 'completed'
  | 'denied'
  | 'failed'
  | 'cancelled'

export interface BrowserActivityView {
  readonly activityId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId?: string
  readonly agentPath: string
  readonly toolCallId: string
  readonly action: BrowserAction
  readonly argumentNames: readonly string[]
  readonly state: BrowserActivityState
  readonly createdAt: string
  readonly updatedAt: string
  readonly pageId?: string
  readonly url?: string
  readonly title?: string
  readonly attachment?: BrowserAttachmentView
  readonly observationReceipt?: SourceObservationReceiptView
  readonly error?: { readonly code: BrowserErrorCode; readonly message: string }
}

export interface BrowserToolServiceOptions {
  readonly workspacePath: string
  readonly repoRootPath: string
  readonly manager: BrowserManager
  readonly observationStore?: SourceObservationStore
  readonly now?: () => Date
}

export type BrowserCapabilityPolicyDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'require-approval'; readonly reason: string }
  | {
      readonly kind: 'deny'
      readonly code: string
      readonly reason: string
      readonly output: BrowserToolOutput
    }

export type BrowserCapabilityAuthorization =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny'
      readonly code: string
      readonly reason: string
      readonly output: BrowserToolOutput
    }

export type BrowserCapabilityLifecycleTransition =
  | { readonly kind: 'awaiting-approval' }
  | { readonly kind: 'running' }
  | {
      readonly kind: 'terminal'
      readonly status:
        | 'completed'
        | 'rejected'
        | 'cancelled'
        | 'failed'
        | 'indeterminate'
      readonly code?: string
      readonly detail?: unknown
    }

export interface BrowserPreparedCapability {
  readonly context: McpBrokerRequestContext & {
    readonly activityScopeId?: string
  }
  readonly toolCallId: string
  readonly rawInput: McpJsonObject
  readonly input: BrowserToolInput
  readonly assignmentPath: string
  readonly agentPolicy: BrowserAgentPolicy
  readonly risk: BrowserActionRisk
  readonly effect: CapabilityEffect
  readonly policyDecision: BrowserCapabilityPolicyDecision
  readonly argumentNames: readonly string[]
  activity: BrowserActivityView
  rawOutput?: BrowserToolOutput
  terminalOutput?: BrowserToolOutput
  terminalProjected: boolean
}

export type BrowserCapabilityPreparation =
  | { readonly kind: 'prepared'; readonly capability: BrowserPreparedCapability }
  | {
      readonly kind: 'rejected'
      readonly code: string
      readonly output: BrowserToolOutput
    }

export class BrowserToolService {
  readonly tool: McpNamespacedTool = {
    serverId: BROWSER_SERVER_ID,
    serverName: 'Managed Browser',
    toolName: BROWSER_TOOL_NAME,
    namespacedName: BROWSER_TOOL_NAME,
    description: [
      'Operate the managed authenticated Chrome profile. Open an allowed URL, observe semantic',
      'snapshot references, navigate, interact, scroll, wait for conditions, read/search chunked',
      'content, capture screenshots, and download and parse files.',
      'CAPTCHA, verification, denied, rate-limited, missing, and empty pages return typed failures.',
      'Do not retry a blocked host during the same turn; pivot to another source.',
      'Never request credentials. Use refs returned by observe instead of CSS selectors.',
    ].join(' '),
    inputSchema: browserToolInputSchema(),
    annotations: { openWorldHint: true },
    risk: 'unknown',
    effect: serialCapabilityEffect('unknown'),
    requiresApproval: false,
  }

  private readonly workspacePath: string
  private readonly now: () => Date
  private readonly activities = new Map<string, BrowserActivityView[]>()
  private readonly loadedSessions = new Set<string>()
  private readonly loadingSessions = new Map<string, Promise<void>>()
  private readonly activityWriteQueues = new Map<string, Promise<void>>()
  private readonly blockedHosts = new Map<string, Map<string, BrowserErrorCode>>()
  private readonly observationStore: SourceObservationStore

  constructor(private readonly options: BrowserToolServiceOptions) {
    this.workspacePath = path.resolve(options.workspacePath)
    this.now = options.now ?? (() => new Date())
    this.observationStore = options.observationStore ?? new SourceObservationStore()
  }

  isEnabledForAgent(agentPath: string): boolean {
    return readBrowserAgentPolicy(this.options.repoRootPath, agentPath).enabled
  }

  async listSession(sessionId: string): Promise<readonly BrowserActivityView[]> {
    await this.ensureSessionLoaded(sessionId)
    return [...(this.activities.get(sessionId) ?? [])]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async readAttachment(
    sessionId: string,
    activityId: string,
  ): Promise<{ readonly data: Buffer; readonly mimeType: string; readonly name: string } | null> {
    const activity = (await this.listSession(sessionId))
      .find((entry) => entry.activityId === activityId)
    if (!activity?.attachment) return null
    const location = buildSessionRunAssignmentLocation(this.workspacePath, activity)
    const assignmentPath = location
      ? await canonicalContainedDirectory(
          this.workspacePath,
          location.relativeAssignmentPath,
        )
      : null
    const target = assignmentPath
      ? resolveRelativePathInside(assignmentPath, activity.attachment.relativePath)
      : null
    if (!target) return null
    try {
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1_024 * 1_024) return null
      return {
        data: await fs.readFile(target),
        mimeType: activity.attachment.mimeType,
        name: activity.attachment.name,
      }
    } catch {
      return null
    }
  }

  async readToolAttachment(
    context: Pick<McpBrokerRequestContext, 'sessionId' | 'runId' | 'assignmentId'>,
    attachment: BrowserAttachmentView,
  ): Promise<{ readonly data: Buffer; readonly mimeType: string } | null> {
    if (attachment.kind !== 'screenshot' || attachment.sizeBytes > 5 * 1_024 * 1_024) return null
    const location = buildSessionRunAssignmentLocation(this.workspacePath, context)
    const assignmentPath = location
      ? await canonicalContainedDirectory(
          this.workspacePath,
          location.relativeAssignmentPath,
        )
      : null
    const target = assignmentPath
      ? resolveRelativePathInside(assignmentPath, attachment.relativePath)
      : null
    if (!target) return null
    try {
      const [stat, real] = await Promise.all([fs.lstat(target), fs.realpath(target)])
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== attachment.sizeBytes ||
        stat.size > 5 * 1_024 * 1_024 ||
        real !== target
      ) return null
      return { data: await fs.readFile(target), mimeType: attachment.mimeType }
    } catch {
      return null
    }
  }

  async releaseAssignment(scope: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId: string
    readonly activityScopeId?: string
  }): Promise<void> {
    if (
      scope.activityScopeId !== undefined &&
      !isSafePathSegment(scope.activityScopeId)
    ) {
      return
    }
    this.blockedHosts.delete(assignmentKey(scope))
    await this.options.manager.closeAssignment(scope)
  }

  async prepareCapability(
    context: McpBrokerRequestContext & { readonly activityScopeId?: string },
    toolCallId: string,
    rawInput: McpJsonObject,
  ): Promise<BrowserCapabilityPreparation> {
    if (
      context.activityScopeId !== undefined &&
      !isSafePathSegment(context.activityScopeId)
    ) {
      return {
        kind: 'rejected',
        code: 'invalid_request',
        output: failure(
          safeAction(rawInput.action),
          'invalid_request',
          'Browser activity scope is invalid.',
        ),
      }
    }

    let input: BrowserToolInput
    try {
      input = parseBrowserToolInput(rawInput)
    } catch (error) {
      return {
        kind: 'rejected',
        code: 'invalid_request',
        output: failure(
          safeAction(rawInput.action),
          'invalid_request',
          error instanceof Error ? error.message : 'Browser input is invalid.',
        ),
      }
    }
    const agentPolicy = readBrowserAgentPolicy(
      this.options.repoRootPath,
      context.agentPath,
    )
    if (!agentPolicy.enabled) {
      return {
        kind: 'rejected',
        code: 'domain_denied',
        output: failure(
          input.action,
          'domain_denied',
          'This agent is not allowed to use the browser.',
        ),
      }
    }
    const location = buildSessionRunAssignmentLocation(this.workspacePath, context)
    const assignmentPath = location
      ? await canonicalContainedDirectory(
          this.workspacePath,
          location.relativeAssignmentPath,
        )
      : null
    if (!assignmentPath) {
      return {
        kind: 'rejected',
        code: 'invalid_request',
        output: failure(
          input.action,
          'invalid_request',
          'Browser assignment scope is unavailable.',
        ),
      }
    }

    const createdAt = this.now().toISOString()
    const activity = await this.appendActivity({
      activityId: randomUUID(),
      sessionId: context.sessionId,
      runId: context.runId,
      assignmentId: context.assignmentId,
      ...(context.activityScopeId
        ? { activityScopeId: context.activityScopeId }
        : {}),
      agentPath: context.agentPath,
      toolCallId,
      action: input.action,
      argumentNames: Object.keys(rawInput).sort(),
      state: 'requested',
      createdAt,
      updatedAt: createdAt,
    })

    const targetHost = browserTargetHost(input)
    const previousFailure = targetHost
      ? this.blockedHosts.get(assignmentKey(context))?.get(targetHost)
      : undefined
    if (previousFailure) {
      const message = `This host is blocked for the rest of the turn after ${previousFailure}. Do not retry it; use another source.`
      const output = failure(input.action, 'source_blocked', message)
      return {
        kind: 'prepared',
        capability: {
          context,
          toolCallId,
          rawInput,
          input,
          assignmentPath,
          agentPolicy,
          risk: 'read-only',
          effect: resolveBrowserCapabilityEffect('read-only'),
          policyDecision: {
            kind: 'deny',
            code: 'source_blocked',
            reason: message,
            output,
          },
          argumentNames: Object.keys(rawInput).sort(),
          activity,
          terminalOutput: output,
          terminalProjected: false,
        },
      }
    }

    let target: BrowserTargetDescription | undefined
    try {
      target = await this.options.manager.describeTarget(
        this.executionScope(context, assignmentPath, agentPolicy),
        input,
      )
    } catch (error) {
      const normalized = normalizeBrowserError(error)
      const output = browserRuntimeFailure(input.action, normalized)
      return {
        kind: 'prepared',
        capability: {
          context,
          toolCallId,
          rawInput,
          input,
          assignmentPath,
          agentPolicy,
          risk: 'read-only',
          effect: resolveBrowserCapabilityEffect('read-only'),
          policyDecision: {
            kind: 'deny',
            code: normalized.code,
            reason: normalized.message,
            output,
          },
          argumentNames: Object.keys(rawInput).sort(),
          activity,
          terminalOutput: output,
          terminalProjected: false,
        },
      }
    }

    const risk = classifyBrowserAction(input.action, target, input.key)
    const effect = resolveBrowserCapabilityEffect(risk)
    let policyDecision: BrowserCapabilityPolicyDecision = { kind: 'allow' }
    if (effect.kind !== 'read-only' && isUnattendedResearchLane(context)) {
      const message = 'Unattended Deep Research lanes cannot pause for browser approval. Use a read-only browser action or another source.'
      const output = failure(input.action, 'approval_denied', message)
      policyDecision = {
        kind: 'deny',
        code: 'approval_denied',
        reason: message,
        output,
      }
    } else if (effect.kind !== 'read-only') {
      policyDecision = {
        kind: 'require-approval',
        reason: `Browser ${risk} action requires approval.`,
      }
    }

    return {
      kind: 'prepared',
      capability: {
        context,
        toolCallId,
        rawInput,
        input,
        assignmentPath,
        agentPolicy,
        risk,
        effect,
        policyDecision,
        argumentNames: Object.keys(rawInput).sort(),
        activity,
        ...(policyDecision.kind === 'deny'
          ? { terminalOutput: policyDecision.output }
          : {}),
        terminalProjected: false,
      },
    }
  }

  async authorizeCapability(
    capability: BrowserPreparedCapability,
    phase: 'initial' | 'before-execute' | 'after-result',
  ): Promise<BrowserCapabilityAuthorization> {
    if (phase !== 'before-execute' || capability.risk === 'read-only') {
      return { kind: 'allow' }
    }
    const targetHost = browserTargetHost(capability.input)
    const previousFailure = targetHost
      ? this.blockedHosts
          .get(assignmentKey(capability.context))
          ?.get(targetHost)
      : undefined
    if (previousFailure) {
      const message = `This host is blocked for the rest of the turn after ${previousFailure}. Do not retry it; use another source.`
      const output = failure(capability.input.action, 'source_blocked', message)
      capability.terminalOutput = output
      return {
        kind: 'deny',
        code: 'source_blocked',
        reason: message,
        output,
      }
    }

    let target: BrowserTargetDescription | undefined
    try {
      target = await this.options.manager.describeTarget(
        this.executionScope(
          capability.context,
          capability.assignmentPath,
          capability.agentPolicy,
        ),
        capability.input,
      )
    } catch (error) {
      const normalized = normalizeBrowserError(error)
      const output = browserRuntimeFailure(capability.input.action, normalized)
      capability.terminalOutput = output
      return {
        kind: 'deny',
        code: normalized.code,
        reason: normalized.message,
        output,
      }
    }
    const currentRisk = classifyBrowserAction(
      capability.input.action,
      target,
      capability.input.key,
    )
    if (browserRiskRank(currentRisk) <= browserRiskRank(capability.risk)) {
      return { kind: 'allow' }
    }
    const message = 'Browser target risk changed after approval; request a new observation before retrying.'
    const output = failure(
      capability.input.action,
      'approval_denied',
      message,
    )
    capability.terminalOutput = output
    return {
      kind: 'deny',
      code: 'browser_target_risk_changed',
      reason: message,
      output,
    }
  }

  async projectCapabilityLifecycle(
    capability: BrowserPreparedCapability,
    transition: BrowserCapabilityLifecycleTransition,
  ): Promise<{ readonly detail?: BrowserToolOutput } | undefined> {
    if (transition.kind === 'awaiting-approval') {
      capability.activity = await this.updateActivity(capability.activity, {
        state: 'awaiting-approval',
      })
      return undefined
    }
    if (transition.kind === 'running') {
      capability.activity = await this.updateActivity(capability.activity, {
        state: 'running',
      })
      return undefined
    }
    if (transition.status === 'completed') return undefined
    if (capability.terminalProjected) {
      return capability.terminalOutput
        ? { detail: capability.terminalOutput }
        : undefined
    }

    const output = capability.terminalOutput ??
      readBrowserToolOutput(transition.detail) ??
      terminalBrowserFailure(capability.input.action, transition)
    const state = terminalActivityState(transition, output)
    const targetHost = browserTargetHost(capability.input) ??
      browserPageHost(output.url)
    if (targetHost && output.error && blocksHost(output.error.code)) {
      const key = assignmentKey(capability.context)
      const current = this.blockedHosts.get(key) ??
        new Map<string, BrowserErrorCode>()
      current.set(targetHost, output.error.code)
      this.blockedHosts.set(key, current)
    }
    const activityUrl = output.url ??
      (output.error?.code === 'source_blocked' && capability.input.url
        ? safeActivityUrl(capability.input.url)
        : undefined)
    capability.activity = await this.updateActivity(capability.activity, {
      state,
      ...(activityUrl ? { url: activityUrl } : {}),
      ...(output.title ? { title: output.title } : {}),
      ...(output.error ? { error: output.error } : {}),
    })
    capability.terminalOutput = output
    capability.terminalProjected = true
    return { detail: output }
  }

  async executeCapability(
    capability: BrowserPreparedCapability,
    signal?: AbortSignal,
  ): Promise<BrowserToolOutput> {
    try {
      const output = await this.options.manager.execute(
        this.executionScope(
          capability.context,
          capability.assignmentPath,
          capability.agentPolicy,
        ),
        capability.input,
        signal,
      )
      if (!output.ok || output.action !== capability.input.action) {
        throw receiptStorageError()
      }
      capability.rawOutput = output
      return output
    } catch (error) {
      const normalized = normalizeBrowserError(error)
      capability.terminalOutput = browserRuntimeFailure(
        capability.input.action,
        normalized,
      )
      throw error
    }
  }

  async acceptCapabilityResult(
    capability: BrowserPreparedCapability,
    value: unknown,
  ): Promise<BrowserToolOutput> {
    if (!capability.rawOutput || value !== capability.rawOutput) {
      capability.terminalOutput = failure(
        capability.input.action,
        'internal',
        'Browser action returned an invalid result.',
        true,
      )
      throw receiptStorageError()
    }
    try {
      const output = capability.rawOutput
      const observationReceipt = await this.persistObservationReceipt({
        context: capability.context,
        assignmentPath: capability.assignmentPath,
        activity: capability.activity,
        input: capability.input,
        output,
      })
      const completedOutput = observationReceipt
        ? { ...output, url: observationReceipt.canonicalUrl, observationReceipt }
        : output
      capability.activity = await this.updateActivity(capability.activity, {
        state: 'completed',
        ...(output.pageId ? { pageId: output.pageId } : {}),
        ...(completedOutput.url ? { url: completedOutput.url } : {}),
        ...(output.title ? { title: output.title } : {}),
        ...(output.attachment ? { attachment: output.attachment } : {}),
        ...(observationReceipt ? { observationReceipt } : {}),
      })
      return completedOutput
    } catch (error) {
      const normalized = normalizeBrowserError(error)
      capability.terminalOutput = browserRuntimeFailure(
        capability.input.action,
        normalized,
      )
      throw error
    }
  }

  private executionScope(
    context: McpBrokerRequestContext & { readonly activityScopeId?: string },
    assignmentPath: string,
    policy: BrowserAgentPolicy,
  ) {
    return { ...context, assignmentPath, policy }
  }

  private async persistObservationReceipt(input: {
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId?: string
    }
    readonly assignmentPath: string
    readonly activity: BrowserActivityView
    readonly input: BrowserToolInput
    readonly output: BrowserToolOutput
  }): Promise<SourceObservationReceiptView | undefined> {
    const activityScopeId = input.context.activityScopeId
    if (!activityScopeId || !input.output.url || !input.output.content) {
      return undefined
    }
    const content = await readReceiptContent(
      input.assignmentPath,
      input.output.content.id,
      input.output.content.sizeBytes,
    )
    const observedAt = this.now().toISOString()
    const persisted = await this.observationStore.persist({
      assignmentPath: input.assignmentPath,
      identity: {
        sessionId: input.context.sessionId,
        runId: input.context.runId,
        assignmentId: input.context.assignmentId,
        activityScopeId,
        agentPath: input.context.agentPath,
        ...(input.context.agentDisplayName
          ? { agentDisplayName: input.context.agentDisplayName }
          : {}),
      },
      activityId: input.activity.activityId,
      method: 'managed-browser',
      requestedUrl: input.input.url ?? input.output.url,
      finalUrl: input.output.url,
      ...(input.output.title
        ? { title: boundedReceiptTitle(input.output.title) }
        : {}),
      mediaType: 'text/html',
      content: content.data.toString('utf8'),
      attempts: [{
        method: 'managed-browser',
        outcome: 'usable',
        startedAt: input.activity.createdAt,
        durationMs: Math.max(
          0,
          this.now().getTime() - new Date(input.activity.createdAt).getTime(),
        ),
        contentBytes: content.bytes,
      }],
      observedAt,
    })
    return persisted.view
  }

  private async appendActivity(activity: BrowserActivityView): Promise<BrowserActivityView> {
    await this.ensureSessionLoaded(activity.sessionId)
    const current = this.activities.get(activity.sessionId) ?? []
    current.push(activity)
    if (current.length > MAX_ACTIVITY_PER_SESSION) current.splice(0, current.length - MAX_ACTIVITY_PER_SESSION)
    this.activities.set(activity.sessionId, current)
    await this.persistSession(activity.sessionId)
    return activity
  }

  private async updateActivity(
    activity: BrowserActivityView,
    patch: Partial<Omit<BrowserActivityView, 'activityId' | 'sessionId' | 'createdAt'>>,
  ): Promise<BrowserActivityView> {
    const next = { ...activity, ...patch, updatedAt: this.now().toISOString() }
    const current = this.activities.get(activity.sessionId) ?? []
    const index = current.findIndex((entry) => entry.activityId === activity.activityId)
    if (index >= 0) current[index] = next
    await this.persistSession(activity.sessionId)
    return next
  }

  private async ensureSessionLoaded(sessionId: string): Promise<void> {
    if (this.loadedSessions.has(sessionId) || !isSafePathSegment(sessionId)) return
    const existing = this.loadingSessions.get(sessionId)
    if (existing) return existing
    const loading = (async () => {
      const filePath = this.activityPath(sessionId)
      if (!filePath) return
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
        if (Array.isArray(parsed)) {
          this.activities.set(
            sessionId,
            parsed.filter((entry): entry is BrowserActivityView => isBrowserActivity(entry, sessionId))
              .slice(-MAX_ACTIVITY_PER_SESSION),
          )
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.activities.set(sessionId, [])
        }
      } finally {
        this.loadedSessions.add(sessionId)
        this.loadingSessions.delete(sessionId)
      }
    })()
    this.loadingSessions.set(sessionId, loading)
    return loading
  }

  private persistSession(sessionId: string): Promise<void> {
    const filePath = this.activityPath(sessionId)
    if (!filePath) return Promise.resolve()
    const previous = this.activityWriteQueues.get(sessionId) ?? Promise.resolve()
    const write = previous.catch(() => undefined).then(async () => {
      const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const activities = (this.activities.get(sessionId) ?? []).slice(-MAX_ACTIVITY_PER_SESSION)
        await fs.writeFile(temporary, `${JSON.stringify(activities, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        })
        await fs.rename(temporary, filePath)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
    }).finally(() => {
      if (this.activityWriteQueues.get(sessionId) === write) {
        this.activityWriteQueues.delete(sessionId)
      }
    })
    this.activityWriteQueues.set(sessionId, write)
    return write
  }

  private activityPath(sessionId: string): string | null {
    if (!isSafePathSegment(sessionId)) return null
    return resolveRelativePathInside(
      this.workspacePath,
      `sessions/${sessionId}/browser-activity.json`,
    )
  }
}

async function readReceiptContent(
  assignmentPath: string,
  contentId: string,
  expectedBytes: number,
): Promise<{
  readonly data: Buffer
  readonly bytes: number
}> {
  if (
    !isSafePathSegment(contentId) ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > 10 * 1_024 * 1_024
  ) {
    throw receiptStorageError()
  }
  const relativePath = `browser-content/${contentId}.txt`
  const contentPath = resolveRelativePathInside(assignmentPath, relativePath)
  const contentDirectory = resolveRelativePathInside(
    assignmentPath,
    'browser-content',
  )
  if (!contentPath || !contentDirectory) throw receiptStorageError()

  let handle: fs.FileHandle | undefined
  try {
    const [assignmentStat, assignmentReal, directoryStat, directoryReal] =
      await Promise.all([
        fs.lstat(assignmentPath),
        fs.realpath(assignmentPath),
        fs.lstat(contentDirectory),
        fs.realpath(contentDirectory),
      ])
    if (
      !assignmentStat.isDirectory() ||
      assignmentStat.isSymbolicLink() ||
      assignmentReal !== path.resolve(assignmentPath) ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      directoryReal !== path.join(assignmentReal, 'browser-content')
    ) {
      throw receiptStorageError()
    }
    handle = await fs.open(
      contentPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const [fileStat, fileReal] = await Promise.all([
      handle.stat(),
      fs.realpath(contentPath),
    ])
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      fileReal !== contentPath ||
      fileStat.size !== expectedBytes ||
      (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600)
    ) {
      throw receiptStorageError()
    }
    const contents = await handle.readFile()
    if (contents.byteLength !== expectedBytes) throw receiptStorageError()
    return {
      data: contents,
      bytes: contents.byteLength,
    }
  } catch (error) {
    if (error instanceof BrowserRuntimeError) throw error
    throw receiptStorageError()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function boundedReceiptTitle(value: string): string {
  const normalized = value.trim()
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > 16 * 1_024) {
    throw receiptStorageError()
  }
  return normalized
}

function receiptStorageError(): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'internal',
    'Browser observation could not be recorded safely.',
  )
}

export function parseBrowserToolInput(value: unknown): BrowserToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Browser input must be an object.')
  const record = value as Record<string, unknown>
  const allowed = new Set([
    'action', 'pageId', 'url', 'ref', 'text', 'value', 'key', 'direction', 'amount',
    'waitFor', 'query', 'snapshotId', 'contentId', 'chunkIndex', 'waitMs', 'timeoutMs',
  ])
  if (Object.keys(record).some((key) => !allowed.has(key))) invalid('Browser input contains an unsupported field.')
  const actions: BrowserAction[] = [
    'open', 'observe', 'navigate', 'go_back', 'click', 'type', 'select', 'press',
    'scroll', 'wait', 'read_content', 'search_content', 'screenshot', 'download', 'close',
  ]
  if (typeof record.action !== 'string' || !actions.includes(record.action as BrowserAction)) {
    invalid('Browser action is invalid.')
  }
  for (const key of [
    'pageId', 'url', 'ref', 'text', 'value', 'key', 'direction', 'waitFor', 'query',
    'snapshotId', 'contentId',
  ] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') invalid(`${key} must be a string.`)
  }
  for (const key of ['waitMs', 'timeoutMs'] as const) {
    if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || Number(record[key]) < 100 || Number(record[key]) > 600000)) {
      invalid(`${key} must be an integer between 100 and 600000.`)
    }
  }
  if (record.direction !== undefined && !['up', 'down', 'top', 'bottom'].includes(String(record.direction))) {
    invalid('direction is invalid.')
  }
  if (record.waitFor !== undefined && ![
    'delay', 'text', 'url', 'element', 'change', 'network_idle',
  ].includes(String(record.waitFor))) {
    invalid('waitFor is invalid.')
  }
  if (record.amount !== undefined && (!Number.isSafeInteger(record.amount) || Number(record.amount) < 1 || Number(record.amount) > 10000)) {
    invalid('amount must be an integer between 1 and 10000.')
  }
  if (record.chunkIndex !== undefined && (!Number.isSafeInteger(record.chunkIndex) || Number(record.chunkIndex) < 0)) {
    invalid('chunkIndex must be a non-negative integer.')
  }
  return {
    action: record.action as BrowserAction,
    ...(record.pageId !== undefined ? { pageId: record.pageId as string } : {}),
    ...(record.url !== undefined ? { url: record.url as string } : {}),
    ...(record.ref !== undefined ? { ref: record.ref as string } : {}),
    ...(record.text !== undefined ? { text: record.text as string } : {}),
    ...(record.value !== undefined ? { value: record.value as string } : {}),
    ...(record.key !== undefined ? { key: record.key as string } : {}),
    ...(record.direction !== undefined ? { ...whenDefined(record.direction as BrowserToolInput['direction'], (direction) => ({ direction })) } : {}),
    ...(record.amount !== undefined ? { amount: Number(record.amount) } : {}),
    ...(record.waitFor !== undefined ? { ...whenDefined(record.waitFor as BrowserToolInput['waitFor'], (waitFor) => ({ waitFor })) } : {}),
    ...(record.query !== undefined ? { query: record.query as string } : {}),
    ...(record.snapshotId !== undefined ? { snapshotId: record.snapshotId as string } : {}),
    ...(record.contentId !== undefined ? { contentId: record.contentId as string } : {}),
    ...(record.chunkIndex !== undefined ? { chunkIndex: Number(record.chunkIndex) } : {}),
    ...(record.waitMs !== undefined ? { waitMs: Number(record.waitMs) } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: Number(record.timeoutMs) } : {}),
  }
}

function invalid(message: string): never {
  throw new BrowserRuntimeError('invalid_request', message)
}

function safeAction(value: unknown): BrowserAction {
  return typeof value === 'string' ? value as BrowserAction : 'observe'
}

function failure(
  action: BrowserAction,
  code: BrowserErrorCode,
  message: string,
  retryable = false,
  page?: BrowserRuntimeError['page'],
): BrowserToolOutput {
  return {
    ok: false,
    action,
    ...(page?.url ? { url: page.url } : {}),
    ...(page?.title ? { title: page.title } : {}),
    ...(page?.httpStatus !== undefined ? { httpStatus: page.httpStatus } : {}),
    error: { code, message, retryable },
  }
}

function browserRuntimeFailure(
  action: BrowserAction,
  error: BrowserRuntimeError,
): BrowserToolOutput {
  return failure(
    action,
    error.code,
    error.message,
    error.retryable,
    error.page,
  )
}

function browserRiskRank(risk: BrowserActionRisk): number {
  switch (risk) {
    case 'read-only':
      return 0
    case 'mutating':
      return 1
    case 'destructive':
      return 2
  }
}

function terminalBrowserFailure(
  action: BrowserAction,
  transition: Extract<
    BrowserCapabilityLifecycleTransition,
    { readonly kind: 'terminal' }
  >,
): BrowserToolOutput {
  if (transition.status === 'cancelled') {
    if (
      transition.code === 'approval_cancelled' ||
      transition.code === 'approval_interrupted'
    ) {
      return failure(
        action,
        'approval_denied',
        'Browser action approval was cancelled.',
      )
    }
    return failure(action, 'cancelled', 'Browser action was cancelled.')
  }
  if (transition.status === 'rejected') {
    if (transition.code === 'approval_expired') {
      return failure(
        action,
        'approval_expired',
        'Browser action approval expired.',
      )
    }
    if (transition.code === 'approval_denied') {
      return failure(action, 'approval_denied', 'Browser action was denied.')
    }
    if (transition.code === 'domain_denied') {
      return failure(
        action,
        'domain_denied',
        'This browser capability was denied.',
      )
    }
  }
  return failure(
    action,
    'internal',
    transition.status === 'indeterminate'
      ? 'Browser action outcome is indeterminate.'
      : 'Browser action failed.',
    true,
  )
}

function terminalActivityState(
  transition: Extract<
    BrowserCapabilityLifecycleTransition,
    { readonly kind: 'terminal' }
  >,
  output: BrowserToolOutput,
): BrowserActivityState {
  if (transition.status === 'cancelled' || output.error?.code === 'cancelled') {
    return 'cancelled'
  }
  if (
    output.error?.code === 'approval_denied' ||
    output.error?.code === 'approval_expired' ||
    output.error?.code === 'domain_denied'
  ) {
    return 'denied'
  }
  return 'failed'
}

function readBrowserToolOutput(value: unknown): BrowserToolOutput | null {
  return isBrowserToolOutput(value) ? value : null
}

function isBrowserToolOutput(value: unknown): value is BrowserToolOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    typeof record.ok !== 'boolean' ||
    typeof record.action !== 'string' ||
    !BROWSER_ACTIVITY_ACTIONS.has(record.action)
  ) {
    return false
  }
  return record.ok || isBrowserActivityError(record.error)
}

function normalizeBrowserError(error: unknown): BrowserRuntimeError {
  if (error instanceof BrowserRuntimeError) return error
  return new BrowserRuntimeError('internal', 'Browser action failed.', true)
}

async function canonicalContainedDirectory(
  rootDirectory: string,
  relativeDirectory: string,
): Promise<string | null> {
  try {
    if (path.isAbsolute(relativeDirectory) || relativeDirectory.includes('\0')) {
      return null
    }
    const segments = relativeDirectory.split('/')
    if (segments.some((segment) => !isSafePathSegment(segment))) return null

    const rootRealPath = await fs.realpath(rootDirectory)
    const rootStat = await fs.lstat(rootRealPath)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null

    let currentPath = rootRealPath
    for (const segment of segments) {
      currentPath = path.join(currentPath, segment)
      const stat = await fs.lstat(currentPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    }
    return currentPath
  } catch {
    return null
  }
}

function isUnattendedResearchLane(
  context: McpBrokerRequestContext & { readonly activityScopeId?: string },
): boolean {
  return Boolean(context.activityScopeId) && context.agentPath === 'agents/web-researcher'
}

function assignmentKey(scope: {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly activityScopeId?: string
}): string {
  return [
    scope.sessionId,
    scope.runId,
    scope.assignmentId,
    scope.activityScopeId ?? '',
  ].join('\0')
}

function browserTargetHost(input: BrowserToolInput): string | null {
  if ((input.action !== 'open' && input.action !== 'navigate') || !input.url) return null
  try {
    return new URL(input.url).hostname.toLocaleLowerCase()
  } catch {
    return null
  }
}

function browserPageHost(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname.toLocaleLowerCase()
  } catch {
    return null
  }
}

/**
 * Which browser failures suppress later same-lane calls to the host.
 *
 * A challenge is deliberately absent. The agent may not cite a challenged page,
 * but a later explicit call must still be able to reach Chrome; banning the host
 * turned one anti-bot interstitial into a lane-wide dead end. A 403 and a 429
 * are the source refusing this caller, which a second identical call cannot
 * change, so they keep the ban.
 */
function blocksHost(code: BrowserErrorCode): boolean {
  return code === 'access_denied' || code === 'rate_limited'
}

function safeActivityUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '[invalid URL]'
  }
}

function isBrowserActivity(value: unknown, sessionId: string): value is BrowserActivityView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.sessionId === sessionId &&
    typeof record.activityId === 'string' &&
    typeof record.runId === 'string' &&
    typeof record.assignmentId === 'string' &&
    (record.activityScopeId === undefined ||
      (typeof record.activityScopeId === 'string' &&
        isSafePathSegment(record.activityScopeId))) &&
    typeof record.agentPath === 'string' &&
    typeof record.toolCallId === 'string' &&
    BROWSER_ACTIVITY_ACTIONS.has(String(record.action)) &&
    Array.isArray(record.argumentNames) &&
    record.argumentNames.every((name) => typeof name === 'string') &&
    BROWSER_ACTIVITY_STATES.has(String(record.state)) &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    optionalString(record.pageId) &&
    optionalString(record.url) &&
    optionalString(record.title) &&
    (record.error === undefined || isBrowserActivityError(record.error)) &&
    (record.attachment === undefined || isBrowserActivityAttachment(record.attachment)) &&
    (record.observationReceipt === undefined ||
      isManagedBrowserObservationReceiptView(
        record.observationReceipt,
        record.activityId,
        typeof record.activityScopeId === 'string'
          ? record.activityScopeId
          : undefined,
      ))
  )
}

const BROWSER_ACTIVITY_ACTIONS: ReadonlySet<string> = new Set([
  'open', 'observe', 'navigate', 'go_back', 'click', 'type', 'select', 'press',
  'scroll', 'wait', 'read_content', 'search_content', 'screenshot', 'download', 'close',
])

const BROWSER_ACTIVITY_STATES: ReadonlySet<string> = new Set([
  'requested', 'awaiting-approval', 'running', 'completed', 'denied', 'failed', 'cancelled',
])

const BROWSER_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request', 'browser_unavailable', 'domain_denied', 'access_challenge',
  'access_denied', 'rate_limited', 'not_found', 'empty_content', 'source_blocked',
  'page_not_found', 'element_not_found', 'sensitive_input_blocked', 'approval_denied',
  'approval_expired', 'download_too_large', 'timeout', 'cancelled', 'internal',
])

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isBrowserActivityError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return BROWSER_ERROR_CODES.has(String(record.code)) && typeof record.message === 'string'
}

function isBrowserActivityAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    (record.kind === 'screenshot' || record.kind === 'download') &&
    typeof record.name === 'string' &&
    typeof record.relativePath === 'string' &&
    typeof record.mimeType === 'string' &&
    typeof record.sizeBytes === 'number' &&
    Number.isSafeInteger(record.sizeBytes) &&
    Number(record.sizeBytes) >= 0
  )
}

function isManagedBrowserObservationReceiptView(
  value: unknown,
  activityId: unknown,
  activityScopeId: string | undefined,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const expectedRelativePath = activityScopeId && typeof activityId === 'string'
    ? `research/observations/${activityScopeId}/${activityId}.json`
    : undefined
  return (
    (
      isSupportedSourceObservationReceiptVersion(record.schemaVersion)
    ) &&
    typeof record.receiptId === 'string' &&
    record.receiptId === activityId &&
    record.activityId === activityId &&
    record.activityScopeId === activityScopeId &&
    record.relativePath === expectedRelativePath &&
    record.method === 'managed-browser' &&
    typeof record.requestedUrl === 'string' &&
    isCanonicalReceiptUrl(record.requestedUrl) &&
    typeof record.finalUrl === 'string' &&
    isCanonicalReceiptUrl(record.finalUrl) &&
    typeof record.canonicalUrl === 'string' &&
    isCanonicalReceiptUrl(record.canonicalUrl) &&
    typeof record.observedAt === 'string' &&
    !Number.isNaN(Date.parse(record.observedAt)) &&
    typeof record.contentRelativePath === 'string' &&
    new RegExp(
      `^research/acquisitions/${activityScopeId ?? ''}/${activityId ?? ''}/content\\.md$`,
    ).test(
      record.contentRelativePath,
    ) &&
    typeof record.contentSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(record.contentSha256) &&
    typeof record.contentBytes === 'number' &&
    Number.isSafeInteger(record.contentBytes) &&
    record.contentBytes > 0
  )
}

function isCanonicalReceiptUrl(value: string): boolean {
  try {
    return canonicalizeSourceUrl(value) === value
  } catch {
    return false
  }
}
