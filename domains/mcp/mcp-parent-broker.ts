import { createHash } from "node:crypto";

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";

import { normalizeExternalCapabilityEffect } from "../../contracts/capability-effect.js";
import type {
  CapabilityApprovalPort,
  CapabilityDispatcherPorts,
  CapabilityEvidencePort,
} from "../../contracts/capability-dispatch.js";
import type { CapabilityDispatchLifecycle } from "../../contracts/capability-dispatch-lifecycle.js";
import {
  DEFAULT_MCP_APPROVAL_WAIT_TIMEOUT_MS,
  type McpApprovalCoordinator,
  type McpApprovalCoordinatorDecision,
} from "./mcp-approval-coordinator.js";
import { McpApprovalError, hashMcpApprovalArguments } from "./mcp-approval.js";
import {
  McpClientManagerError,
  type McpClientManager,
  type McpConnectionSnapshot,
} from "./mcp-client-manager.js";
import {
  canonicalizeMcpJson,
  mcpBrokerError,
  normalizeMcpBrokerLimits,
  normalizeMcpJsonValue,
  safeMcpRequestId,
  validateMcpBrokerCallRequest,
  validateMcpBrokerContext,
  validateMcpRunLease,
  type McpBrokerLimits,
} from "./mcp-broker-policy.js";
import {
  createMcpCapabilityDispatcher,
  McpCapabilityAdapter,
  McpCapabilityStageError,
  mcpCapabilityDispatchRequest,
} from "./mcp-capability-adapter.js";
import {
  McpEvidenceStoreError,
  type McpAuditEventInput,
  type McpAuditToolBindingInput,
  type McpEvidenceStore,
  type McpToolResultEvidenceView,
} from "./mcp-evidence-store.js";
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  namespaceMcpToolName,
  type McpBrokerCallRequest,
  type McpBrokerCallResult,
  type McpBrokerListRequest,
  type McpBrokerListResult,
  type McpBrokerRequestContext,
  type McpJsonObject,
  type McpJsonSchema,
  type McpNamespacedTool,
  type McpRunLeaseClaims,
  type McpSanitizedError,
  type McpToolResultContent,
} from "./mcp-runtime.js";
import type { McpServerView } from "./mcp-settings.js";

export type McpAuthorizationRevocationCode =
  "server_disabled" | "grant_required";

export interface McpAuthorizationCompletionFence {
  release(): void;
}

export interface McpAuthorizationGuard {
  readonly signal: AbortSignal;
  getRevocationCode(): McpAuthorizationRevocationCode | null;
  beginCompletion(): McpAuthorizationCompletionFence | null;
}

export interface McpBrokerSettingsReader {
  listServers(): Promise<readonly McpServerView[]>;
  getAuthorizationGuard?(
    agentPath: string,
    serverId: string,
  ): McpAuthorizationGuard;
}

export interface McpEffectiveGrantRequest {
  readonly context: McpBrokerRequestContext;
  readonly serverId: string;
}

export type McpEffectiveGrantResolver = (
  request: McpEffectiveGrantRequest,
) => boolean | Promise<boolean>;

export type McpRunLeaseResolver = (
  context: McpBrokerRequestContext,
) => McpRunLeaseClaims | null | Promise<McpRunLeaseClaims | null>;

export interface McpEvidenceStoreFactoryScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
}

export type McpBrokerEvidenceStore = Pick<
  McpEvidenceStore,
  "appendAuditEvent" | "importToolResultEvidence"
>;

export type McpEvidenceStoreFactory = (
  scope: McpEvidenceStoreFactoryScope,
) => McpBrokerEvidenceStore;

export interface McpParentBrokerOptions {
  readonly settingsService: McpBrokerSettingsReader;
  readonly clientManager: Pick<McpClientManager, "getSnapshot" | "callTool">;
  readonly grantResolver: McpEffectiveGrantResolver;
  readonly leaseResolver: McpRunLeaseResolver;
  readonly approvalCoordinator?: Pick<
    McpApprovalCoordinator,
    "requestApproval"
  >;
  readonly approvalWaitTimeoutMs?: number;
  readonly evidenceStoreFactory?: McpEvidenceStoreFactory;
  readonly capabilityEvidence?: CapabilityEvidencePort;
  readonly durable?: CapabilityDispatcherPorts["durable"];
  readonly limits?: Partial<McpBrokerLimits>;
  readonly now?: () => Date;
  /**
   * The shared admission/drain/finalization authority (AC18). Required: a
   * construction intentionally outside shared coordination passes the
   * explicit pass-through participant rather than omitting the seam.
   */
  readonly lifecycle: CapabilityDispatchLifecycle;
}

export interface McpBrokerCallOptions {
  readonly signal?: AbortSignal;
}

interface AuthorizedTool {
  readonly tool: McpNamespacedTool;
}

interface AuthorizedToolSet {
  readonly authorizedServerCount: number;
  readonly tools: readonly McpNamespacedTool[];
  readonly byName: ReadonlyMap<string, AuthorizedTool>;
  readonly collisions: ReadonlySet<string>;
  readonly errors: readonly McpSanitizedError[];
}

interface BrokerCallRecord {
  readonly fingerprint: string;
  readonly namespacedToolName: string;
  readonly result: Promise<McpBrokerCallResult>;
  serverId?: string;
  toolFingerprint?: string;
  approvalVerified?: boolean;
}

interface BrokerRunState {
  readonly records: Map<string, BrokerCallRecord>;
  callsStarted: number;
  activeCalls: number;
  outputBytes: number;
  releaseRequested: boolean;
}

interface NormalizedToolResponse {
  readonly isError: boolean;
  readonly content: readonly McpToolResultContent[];
}

interface BrokerExecutionDeadline {
  readonly signal: AbortSignal;
  readonly callerSignal?: AbortSignal;
  readonly expiresAt: number;
}

interface BrokerAuditContext {
  readonly store: McpBrokerEvidenceStore;
  readonly binding: Omit<McpAuditToolBindingInput, "timestamp">;
}

class BrokerExecutionAbortedError extends Error {
  constructor(readonly code: "cancelled" | "timeout") {
    super(code);
    this.name = "BrokerExecutionAbortedError";
  }
}

class BrokerAuditWriteError extends Error {
  constructor() {
    super("audit_write_failed");
    this.name = "BrokerAuditWriteError";
  }
}

export class McpParentBroker {
  private readonly limits: McpBrokerLimits;
  private readonly now: () => Date;
  private readonly approvalWaitTimeoutMs: number;
  private readonly runStates = new Map<string, BrokerRunState>();
  private readonly schemaValidators = new WeakMap<
    object,
    JsonSchemaValidator<McpJsonObject>
  >();

  constructor(private readonly options: McpParentBrokerOptions) {
    this.limits = normalizeMcpBrokerLimits(options.limits);
    this.now = options.now ?? (() => new Date());
    this.approvalWaitTimeoutMs = positiveBrokerDuration(
      options.approvalWaitTimeoutMs,
      DEFAULT_MCP_APPROVAL_WAIT_TIMEOUT_MS,
    );
  }

  get toolLoopTimeoutMs(): number {
    const interactionWindows = this.options.approvalCoordinator ? 2 : 1;
    return (
      interactionWindows * this.approvalWaitTimeoutMs +
      this.limits.perCallTimeoutMs +
      1_000
    );
  }

  async listTools(request: McpBrokerListRequest): Promise<McpBrokerListResult> {
    const rawContext = "context" in request ? request.context : undefined;
    const context = validateMcpBrokerContext(rawContext);
    const requestId = context.ok
      ? context.value.requestId
      : safeMcpRequestId(rawContext);
    if (!context.ok) return this.listFailure(requestId, context.error);

    const leaseError = await this.resolveLeaseError(context.value);
    if (leaseError) return this.listFailure(requestId, leaseError);

    try {
      const authorized = await this.collectAuthorizedTools(context.value);
      const outputBytes = Buffer.byteLength(
        canonicalizeMcpJson(authorized.tools),
        "utf8",
      );
      if (outputBytes > this.limits.maxOutputBytes) {
        return this.listFailure(
          requestId,
          mcpBrokerError("result_too_large", false, requestId),
        );
      }
      return {
        contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
        requestId,
        generatedAt: this.now().toISOString(),
        authorizedServerCount: authorized.authorizedServerCount,
        tools: authorized.tools,
        errors: authorized.errors,
      };
    } catch {
      return this.listFailure(
        requestId,
        mcpBrokerError("internal", true, requestId),
      );
    }
  }

  async callTool(
    input: McpBrokerCallRequest,
    callOptions: McpBrokerCallOptions = {},
  ): Promise<McpBrokerCallResult> {
    const execution = createBrokerExecutionDeadline(
      callOptions.signal,
      this.limits.perCallTimeoutMs,
    );
    const validated = validateMcpBrokerCallRequest(input, this.limits);
    if (!validated.ok) {
      return callFailure(input, validated.error);
    }
    const request = validated.value.request;
    if (execution.signal.aborted) {
      return callFailure(
        request,
        brokerExecutionError(execution, request.context.requestId),
      );
    }

    const leaseError = await this.resolveLeaseError(request.context, execution);
    if (leaseError) return callFailure(request, leaseError);

    const runState = this.getOrCreateRunState(request.context);
    if (!runState || runState.releaseRequested) {
      return callFailure(
        request,
        mcpBrokerError("result_too_large", true, request.context.requestId),
      );
    }
    const recordKey = brokerCallRecordKey(request);
    const fingerprint = brokerCallFingerprint(
      request,
      validated.value.canonicalArguments,
    );
    const existing = runState.records.get(recordKey);
    if (existing) {
      return this.resolveExistingCall(
        request,
        existing,
        fingerprint,
        createBrokerExecutionDeadline(
          callOptions.signal,
          this.toolLoopTimeoutMs,
        ),
      );
    }
    if (!this.reserveCall(runState)) {
      return callFailure(
        request,
        mcpBrokerError("result_too_large", true, request.context.requestId),
      );
    }

    let resolveResult!: (result: McpBrokerCallResult) => void;
    const result = new Promise<McpBrokerCallResult>((resolve) => {
      resolveResult = resolve;
    });
    const record: BrokerCallRecord = {
      fingerprint,
      namespacedToolName: request.namespacedToolName,
      result,
    };
    runState.records.set(recordKey, record);
    const lifecycleScope = {
      sessionId: request.context.sessionId,
      runId: request.context.runId,
      assignmentId: request.context.assignmentId,
    };
    const settleLeader = (callResult: McpBrokerCallResult): void => {
      this.finishCall(request.context, runState);
      resolveResult(callResult);
    };
    void this.options.lifecycle.run({
      scope: lifecycleScope,
      operation: (lifecycleSignal) =>
        this.executeCall(
          request,
          runState,
          record,
          addLifecycleSignal(execution, lifecycleSignal),
        ),
    }).then(
      (outcome) => {
        if (outcome.kind === "ran") {
          settleLeader(outcome.result);
          return;
        }
        const assignmentReleased = outcome.code === "assignment_released";
        if (assignmentReleased) {
          runState.releaseRequested = true;
        }
        settleLeader(
          callFailure(
            request,
            mcpBrokerError(
              assignmentReleased ? "result_too_large" : "cancelled",
              assignmentReleased,
              request.context.requestId,
            ),
          ),
        );
      },
      () => {
        settleLeader(
          callFailure(
            request,
            mcpBrokerError("internal", true, request.context.requestId),
          ),
        );
      },
    );
    return result.then(cloneBrokerCallResult);
  }

  private finishCall(
    context: McpBrokerRequestContext,
    runState: BrokerRunState,
  ): void {
    runState.activeCalls -= 1;
    if (runState.releaseRequested && runState.activeCalls === 0) {
      this.runStates.delete(brokerRunKey(context));
    }
  }

  releaseRun(
    scope: Pick<
      McpBrokerRequestContext,
      "sessionId" | "runId" | "assignmentId" | "leaseId"
    >,
  ): void {
    const key = brokerRunKey(scope);
    const state = this.runStates.get(key);
    if (!state) return;
    state.releaseRequested = true;
    if (state.activeCalls === 0) this.runStates.delete(key);
  }

  private async executeCall(
    request: McpBrokerCallRequest,
    runState: BrokerRunState,
    record: BrokerCallRecord,
    execution: BrokerExecutionDeadline,
  ): Promise<McpBrokerCallResult> {
    let audit: BrokerAuditContext | null = null;
    let authorizationGuard: McpAuthorizationGuard | undefined;
    let preparedTool: McpNamespacedTool | undefined;
    let terminalAuditHandled = false;
    let adapter: McpCapabilityAdapter | undefined;
    const callStartedAt = this.now().getTime();
    const failWithAudit = async (
      error: McpSanitizedError,
    ): Promise<McpSanitizedError> => {
      adapter?.captureError(error);
      terminalAuditHandled = true;
      await this.appendFailureAudit(audit, error, callStartedAt);
      return error;
    };
    const failWithoutAdditionalAudit = (
      error: McpSanitizedError,
    ): McpSanitizedError => {
      adapter?.captureError(error);
      terminalAuditHandled = true;
      return error;
    };

    adapter = new McpCapabilityAdapter({
      request,
      prepare: async () => {
        const selected = await this.resolveAuthorizedTool(request, execution);
        if ("error" in selected) {
          adapter?.captureError(selected.error);
          throw new McpCapabilityStageError(selected.error);
        }
        record.serverId = selected.authorized.tool.serverId;
        preparedTool = selected.authorized.tool;
        record.toolFingerprint = toolAuthorizationFingerprint(
          selected.authorized.tool,
        );

        const schemaError = this.validateToolArguments(
          selected.authorized.tool,
          request.arguments,
          request.context.requestId,
        );
        if (schemaError) {
          adapter?.captureError(schemaError);
          throw new McpCapabilityStageError(schemaError);
        }
        audit = this.createAuditContext(request, selected.authorized.tool);
        if (
          !(await this.appendAuditEvent(audit, {
            ...audit?.binding,
            type: "mcp.tool.requested",
            timestamp: this.now().toISOString(),
          } as McpAuditEventInput))
        ) {
          const error = failWithoutAdditionalAudit(
            mcpBrokerError("internal", true, request.context.requestId),
          );
          throw new McpCapabilityStageError(error);
        }

        return {
          tool: selected.authorized.tool,
          authorize: async (phase) => {
            if (phase === "initial") return null;
            if (phase === "before-execute") {
              authorizationGuard =
                this.options.settingsService.getAuthorizationGuard?.(
                  request.context.agentPath,
                  selected.authorized.tool.serverId,
                );
              const transportExecution = createBrokerExecutionDeadline(
                execution.callerSignal,
                this.limits.perCallTimeoutMs,
              );
              if (transportExecution.signal.aborted) {
                return failWithAudit(
                  brokerExecutionError(
                    transportExecution,
                    request.context.requestId,
                  ),
                );
              }
              const reauthorizationError = await this.reauthorizeTool(
                request.context,
                selected.authorized,
                record.approvalVerified === true,
                transportExecution,
              );
              if (reauthorizationError) {
                return failWithAudit(reauthorizationError);
              }
              if (
                !(await this.appendAuditEvent(audit, {
                  ...audit?.binding,
                  type: "mcp.tool.started",
                  timestamp: this.now().toISOString(),
                } as McpAuditEventInput))
              ) {
                return failWithoutAdditionalAudit(
                  mcpBrokerError("internal", true, request.context.requestId),
                );
              }
              return null;
            }

            const completionExecution = createBrokerExecutionDeadline(
              undefined,
              this.limits.perCallTimeoutMs,
              authorizationGuard ? [authorizationGuard.signal] : [],
            );
            const reauthorizationAfterResult = await this.reauthorizeTool(
              request.context,
              selected.authorized,
              record.approvalVerified === true,
              completionExecution,
            );
            const completionAuthorizationError =
              authorizationGuardError(
                authorizationGuard,
                request.context.requestId,
              ) ?? reauthorizationAfterResult;
            return completionAuthorizationError
              ? failWithAudit(completionAuthorizationError)
              : null;
          },
          execute: async (signal) => {
            const interactiveExecution = createBrokerExecutionDeadline(
              signal,
              this.approvalWaitTimeoutMs + this.limits.perCallTimeoutMs,
              authorizationGuard ? [authorizationGuard.signal] : [],
            );
            try {
              return await awaitBrokerOperation(
                Promise.resolve().then(() =>
                  this.options.clientManager.callTool(
                    selected.authorized.tool.serverId,
                    {
                      name: selected.authorized.tool.toolName,
                      arguments: request.arguments,
                    },
                    {
                      signal: interactiveExecution.signal,
                      timeoutMs:
                        this.approvalWaitTimeoutMs +
                        this.limits.perCallTimeoutMs,
                      elicitation: {
                        context: request.context,
                        toolCallId: request.toolCallId,
                        namespacedToolName: request.namespacedToolName,
                      },
                    },
                  ),
                ),
                interactiveExecution,
              );
            } catch (error) {
              const revoked = signal.aborted
                ? null
                : authorizationGuardError(
                    authorizationGuard,
                    request.context.requestId,
                  );
              const sanitized =
                revoked ??
                sanitizeBrokerCallError(error, request.context.requestId);
              await failWithAudit(sanitized);
              throw new McpCapabilityStageError(sanitized);
            }
          },
          beginCompletion: async () => {
            const completionFence = authorizationGuard?.beginCompletion();
            if (authorizationGuard && !completionFence) {
              const error =
                authorizationGuardError(
                  authorizationGuard,
                  request.context.requestId,
                ) ??
                mcpBrokerError(
                  "grant_required",
                  false,
                  request.context.requestId,
                );
              await failWithAudit(error);
              throw new McpCapabilityStageError(error);
            }
            return completionFence ?? { release: () => undefined };
          },
          acceptResult: async (rawResult) => {
            try {
              const result = await this.acceptToolResult(
                request,
                rawResult,
                runState,
                audit,
                callStartedAt,
              );
              terminalAuditHandled = true;
              return result;
            } catch (error) {
              const sanitized = sanitizeBrokerCallError(
                error,
                request.context.requestId,
              );
              await failWithAudit(sanitized);
              throw new McpCapabilityStageError(sanitized);
            }
          },
        };
      },
    });

    const approval: CapabilityApprovalPort = {
      request: async (input) => {
        const coordinator = this.options.approvalCoordinator;
        if (!coordinator) {
          const error = await failWithAudit(
            mcpBrokerError(
              "approval_required",
              false,
              request.context.requestId,
            ),
          );
          throw new McpCapabilityStageError(error);
        }
        if (!preparedTool) {
          const error = await failWithAudit(
            mcpBrokerError("internal", true, request.context.requestId),
          );
          throw new McpCapabilityStageError(error);
        }
        try {
          const decision = await coordinator.requestApproval({
            context: request.context,
            serverId: input.description.serverId,
            namespacedToolName: input.description.namespacedToolName,
            toolCallId: request.toolCallId,
            toolRisk: preparedTool.risk,
            arguments: request.arguments,
            timeoutMs: this.approvalWaitTimeoutMs,
            signal: input.signal,
            onInteraction: async (interaction) => {
              if (
                !(await this.appendAuditEvent(audit, {
                  ...audit?.binding,
                  type: "mcp.approval.requested",
                  timestamp: this.now().toISOString(),
                  interactionId: interaction.interactionId,
                } as McpAuditEventInput))
              ) {
                throw new BrokerAuditWriteError();
              }
              await input.onInteraction({
                interactionId: interaction.interactionId,
                reused: interaction.status === "approved-run",
              });
            },
          });
          if (!(await this.appendApprovalResolutionAudit(audit, decision))) {
            const error = failWithoutAdditionalAudit(
              mcpBrokerError("internal", true, request.context.requestId),
            );
            throw new McpCapabilityStageError(error);
          }
          if (decision.outcome !== "approved") {
            await failWithAudit(
              approvalDecisionError(decision, request.context.requestId),
            );
          } else {
            record.approvalVerified = true;
          }
          return {
            outcome: decision.outcome,
            interaction: {
              interactionId: decision.interaction.interactionId,
              reused: decision.reused,
            },
          };
        } catch (error) {
          if (error instanceof McpCapabilityStageError) throw error;
          const sanitized = sanitizeBrokerCallError(
            error,
            request.context.requestId,
          );
          await failWithAudit(sanitized);
          throw new McpCapabilityStageError(sanitized);
        }
      },
    };

    try {
      const dispatchResult = await createMcpCapabilityDispatcher({
        approval,
        ...(this.options.capabilityEvidence
          ? { evidence: this.options.capabilityEvidence }
          : {}),
        ...(this.options.durable ? { durable: this.options.durable } : {}),
        teardown: this.options.lifecycle.teardown,
        now: this.now,
      }).dispatch(
        mcpCapabilityDispatchRequest({
          request,
          adapter,
          ...(execution.callerSignal ? { signal: execution.callerSignal } : {}),
        }),
      );
      const result = adapter.toBrokerResult(dispatchResult);
      if (result.isError && !terminalAuditHandled) {
        const error = result.error ??
          mcpBrokerError("internal", true, request.context.requestId);
        await failWithAudit(error);
      }
      return result;
    } catch (error) {
      const revoked = execution.callerSignal?.aborted
        ? null
        : authorizationGuardError(
            authorizationGuard,
            request.context.requestId,
          );
      const sanitized =
        revoked ?? sanitizeBrokerCallError(error, request.context.requestId);
      if (!terminalAuditHandled) await failWithAudit(sanitized);
      return callFailure(request, sanitized);
    }
  }

  private async resolveExistingCall(
    request: McpBrokerCallRequest,
    record: BrokerCallRecord,
    fingerprint: string,
    execution: BrokerExecutionDeadline,
  ): Promise<McpBrokerCallResult> {
    if (record.fingerprint !== fingerprint) {
      return callFailure(
        request,
        mcpBrokerError("invalid_request", false, request.context.requestId),
      );
    }
    let cached: McpBrokerCallResult;
    try {
      cached = await awaitBrokerOperation(record.result, execution);
    } catch (error) {
      return callFailure(
        request,
        sanitizeBrokerCallError(error, request.context.requestId),
      );
    }
    const leaseError = await this.resolveLeaseError(request.context, execution);
    if (leaseError) return callFailure(request, leaseError);
    if (record.serverId) {
      const authorization = await this.authorizeCachedTool(
        request.context,
        record,
        record.serverId,
        cached,
        execution,
      );
      if (authorization) return callFailure(request, authorization);
    }
    return withRequestIdentity(cached, request);
  }

  private async resolveAuthorizedTool(
    request: McpBrokerCallRequest,
    execution: BrokerExecutionDeadline,
  ): Promise<
    | { readonly authorized: AuthorizedTool }
    | { readonly error: McpSanitizedError }
  > {
    try {
      const available = await this.collectAuthorizedTools(
        request.context,
        execution,
      );
      if (available.collisions.has(request.namespacedToolName)) {
        return {
          error: mcpBrokerError(
            "protocol_error",
            false,
            request.context.requestId,
          ),
        };
      }
      const authorized = available.byName.get(request.namespacedToolName);
      if (authorized) return { authorized };
      const internalError = available.errors.find(
        (error) => error.code === "internal",
      );
      return {
        error:
          internalError ??
          mcpBrokerError("tool_not_found", false, request.context.requestId),
      };
    } catch (error) {
      return {
        error: sanitizeBrokerOperationError(error, request.context.requestId),
      };
    }
  }

  private async reauthorizeTool(
    context: McpBrokerRequestContext,
    selected: AuthorizedTool,
    approvalVerified: boolean,
    execution: BrokerExecutionDeadline,
  ): Promise<McpSanitizedError | null> {
    const leaseError = await this.resolveLeaseError(context, execution);
    if (leaseError) return leaseError;
    try {
      const servers = await awaitBrokerOperation(
        this.options.settingsService.listServers(),
        execution,
      );
      const server = servers.find(
        (candidate) => candidate.id === selected.tool.serverId,
      );
      if (
        !isGloballyActive(server) ||
        !this.options.clientManager.getSnapshot(selected.tool.serverId)
      ) {
        return mcpBrokerError("server_disabled", false, context.requestId);
      }
      const available = await this.collectAuthorizedTools(context, execution);
      if (available.collisions.has(selected.tool.namespacedName)) {
        return mcpBrokerError("protocol_error", false, context.requestId);
      }
      const current = available.byName.get(selected.tool.namespacedName);
      if (
        !current ||
        toolAuthorizationFingerprint(current.tool) !==
          toolAuthorizationFingerprint(selected.tool)
      ) {
        return mcpBrokerError("grant_required", false, context.requestId);
      }
      if (current.tool.requiresApproval && !approvalVerified) {
        return mcpBrokerError("approval_required", false, context.requestId);
      }
      return null;
    } catch (error) {
      return sanitizeBrokerOperationError(error, context.requestId);
    }
  }

  private async authorizeCachedTool(
    context: McpBrokerRequestContext,
    record: BrokerCallRecord,
    serverId: string,
    cached: McpBrokerCallResult,
    execution: BrokerExecutionDeadline,
  ): Promise<McpSanitizedError | null> {
    try {
      const servers = await awaitBrokerOperation(
        this.options.settingsService.listServers(),
        execution,
      );
      const server = servers.find((candidate) => candidate.id === serverId);
      if (
        !isGloballyActive(server) ||
        !this.options.clientManager.getSnapshot(serverId)
      ) {
        return mcpBrokerError("server_disabled", false, context.requestId);
      }
      const granted = await awaitBrokerOperation(
        Promise.resolve().then(() =>
          this.options.grantResolver({ context, serverId }),
        ),
        execution,
      );
      if (!granted)
        return mcpBrokerError("grant_required", false, context.requestId);
      const available = await this.collectAuthorizedTools(context, execution);
      if (available.collisions.has(record.namespacedToolName)) {
        return mcpBrokerError("protocol_error", false, context.requestId);
      }
      const current = available.byName.get(record.namespacedToolName)?.tool;
      if (
        !current ||
        current.serverId !== serverId ||
        (record.toolFingerprint &&
          toolAuthorizationFingerprint(current) !== record.toolFingerprint)
      ) {
        return mcpBrokerError("tool_not_found", false, context.requestId);
      }
      return current.requiresApproval &&
        !record.approvalVerified &&
        !cached.isError
        ? mcpBrokerError("approval_required", false, context.requestId)
        : null;
    } catch (error) {
      return sanitizeBrokerOperationError(error, context.requestId);
    }
  }

  private async collectAuthorizedTools(
    context: McpBrokerRequestContext,
    execution?: BrokerExecutionDeadline,
  ): Promise<AuthorizedToolSet> {
    const servers = execution
      ? await awaitBrokerOperation(
          this.options.settingsService.listServers(),
          execution,
        )
      : await this.options.settingsService.listServers();
    const candidates = servers
      .filter(isGloballyActive)
      .map((server) => ({
        server,
        snapshot: this.options.clientManager.getSnapshot(server.id),
      }))
      .filter(hasSnapshot);
    const decisions = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const grant = Promise.resolve().then(() =>
            this.options.grantResolver({
              context,
              serverId: candidate.server.id,
            }),
          );
          const granted = execution
            ? await awaitBrokerOperation(grant, execution)
            : await grant;
          return { candidate, granted, error: null };
        } catch (error) {
          if (error instanceof BrokerExecutionAbortedError) throw error;
          return {
            candidate,
            granted: false,
            error: mcpBrokerError("internal", true, context.requestId),
          };
        }
      }),
    );
    return buildAuthorizedToolSet(
      decisions,
      this.limits.maxSchemaBytes,
      context.requestId,
    );
  }

  private validateToolArguments(
    tool: McpNamespacedTool,
    argumentsValue: McpJsonObject,
    requestId: string,
  ): McpSanitizedError | null {
    try {
      if (
        Buffer.byteLength(canonicalizeMcpJson(tool.inputSchema), "utf8") >
        this.limits.maxSchemaBytes
      ) {
        return mcpBrokerError("protocol_error", false, requestId);
      }
      let validator = this.schemaValidators.get(tool.inputSchema);
      if (!validator) {
        validator = new AjvJsonSchemaValidator().getValidator<McpJsonObject>(
          tool.inputSchema,
        );
        this.schemaValidators.set(tool.inputSchema, validator);
      }
      return validator(argumentsValue).valid
        ? null
        : mcpBrokerError("invalid_request", false, requestId);
    } catch {
      return mcpBrokerError("protocol_error", false, requestId);
    }
  }

  private async acceptToolResult(
    request: McpBrokerCallRequest,
    rawResult: unknown,
    runState: BrokerRunState,
    audit: BrokerAuditContext | null,
    callStartedAt: number,
  ): Promise<McpBrokerCallResult> {
    const normalized = normalizeToolResponse(rawResult);
    if (!normalized) {
      const error = mcpBrokerError(
        "protocol_error",
        false,
        request.context.requestId,
      );
      await this.appendFailureAudit(audit, error, callStartedAt);
      return callFailure(request, error);
    }
    if (normalized.isError) {
      const error = mcpBrokerError(
        "tool_failed",
        false,
        request.context.requestId,
      );
      await this.appendFailureAudit(audit, error, callStartedAt);
      return callFailure(request, error);
    }
    const outputBytes = Buffer.byteLength(
      canonicalizeMcpJson(normalized.content),
      "utf8",
    );
    if (
      outputBytes > this.limits.maxOutputBytes ||
      runState.outputBytes + outputBytes > this.limits.maxOutputBytesPerRun
    ) {
      runState.outputBytes = this.limits.maxOutputBytesPerRun;
      const error = mcpBrokerError(
        "result_too_large",
        false,
        request.context.requestId,
      );
      await this.appendFailureAudit(audit, error, callStartedAt);
      return callFailure(request, error);
    }
    runState.outputBytes += outputBytes;
    let evidence: McpToolResultEvidenceView | null = null;
    if (audit) {
      try {
        evidence = await audit.store.importToolResultEvidence({
          sessionId: request.context.sessionId,
          runId: request.context.runId,
          assignmentId: request.context.assignmentId,
          ...(request.context.workflowId
            ? { workflowId: request.context.workflowId }
            : {}),
          ...(request.context.workflowStepId
            ? { workflowStepId: request.context.workflowStepId }
            : {}),
          agentPath: request.context.agentPath,
          serverId: audit.binding.serverId,
          requestId: request.context.requestId,
          toolCallId: request.toolCallId,
          namespacedToolName: request.namespacedToolName,
          content: normalized.content,
        });
      } catch (error) {
        const sanitized = sanitizeBrokerCallError(
          error,
          request.context.requestId,
        );
        await this.appendFailureAudit(audit, sanitized, callStartedAt);
        return callFailure(request, sanitized);
      }
      if (
        !(await this.appendAuditEvent(audit, {
          ...audit.binding,
          type: "mcp.tool.completed",
          timestamp: this.now().toISOString(),
          durationMs: elapsedMs(this.now().getTime(), callStartedAt),
          resultByteCount: evidence.totalBytes,
          resultHash: evidence.aggregateHash,
        }))
      ) {
        return callFailure(
          request,
          mcpBrokerError("internal", true, request.context.requestId),
        );
      }
    }
    return {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId: request.context.requestId,
      toolCallId: request.toolCallId,
      isError: false,
      content: normalized.content,
      attachments: [],
      evidence: evidence ? [evidence.record] : [],
    };
  }

  private createAuditContext(
    request: McpBrokerCallRequest,
    tool: McpNamespacedTool,
  ): BrokerAuditContext | null {
    if (!this.options.evidenceStoreFactory) return null;
    const argumentSummary = hashMcpApprovalArguments(request.arguments);
    return {
      store: this.options.evidenceStoreFactory({
        sessionId: request.context.sessionId,
        runId: request.context.runId,
        assignmentId: request.context.assignmentId,
      }),
      binding: {
        sessionId: request.context.sessionId,
        runId: request.context.runId,
        assignmentId: request.context.assignmentId,
        ...(request.context.workflowId
          ? { workflowId: request.context.workflowId }
          : {}),
        ...(request.context.workflowStepId
          ? { workflowStepId: request.context.workflowStepId }
          : {}),
        agentPath: request.context.agentPath,
        serverId: tool.serverId,
        requestId: request.context.requestId,
        toolCallId: request.toolCallId,
        namespacedToolName: request.namespacedToolName,
        toolRisk: tool.risk,
        argumentNames: argumentSummary.argumentNames,
        argumentsHash: argumentSummary.argumentsHash,
      },
    };
  }

  private async appendApprovalResolutionAudit(
    audit: BrokerAuditContext | null,
    decision: McpApprovalCoordinatorDecision,
  ): Promise<boolean> {
    if (decision.interaction.status === "pending") return false;
    return this.appendAuditEvent(audit, {
      ...audit?.binding,
      type: "mcp.approval.resolved",
      timestamp: this.now().toISOString(),
      interactionId: decision.interaction.interactionId,
      approvalStatus: decision.interaction.status,
    } as McpAuditEventInput);
  }

  private async appendFailureAudit(
    audit: BrokerAuditContext | null,
    error: McpSanitizedError,
    callStartedAt: number,
  ): Promise<void> {
    if (!audit) return;
    const durationMs = elapsedMs(this.now().getTime(), callStartedAt);
    const event: McpAuditEventInput =
      error.code === "cancelled"
        ? {
            ...audit.binding,
            type: "mcp.tool.cancelled",
            timestamp: this.now().toISOString(),
            durationMs,
          }
        : {
            ...audit.binding,
            type: "mcp.tool.failed",
            timestamp: this.now().toISOString(),
            durationMs,
            errorCode: error.code,
          };
    await this.appendAuditEvent(audit, event);
  }

  private async appendAuditEvent(
    audit: BrokerAuditContext | null,
    event: McpAuditEventInput,
  ): Promise<boolean> {
    if (!audit) return true;
    try {
      await audit.store.appendAuditEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveLeaseError(
    context: McpBrokerRequestContext,
    execution?: BrokerExecutionDeadline,
  ): Promise<McpSanitizedError | null> {
    try {
      const resolution = Promise.resolve().then(() =>
        this.options.leaseResolver(context),
      );
      const claims = execution
        ? await awaitBrokerOperation(resolution, execution)
        : await resolution;
      return validateMcpRunLease(context, claims, this.now().getTime());
    } catch (error) {
      return sanitizeBrokerOperationError(error, context.requestId);
    }
  }

  private reserveCall(state: BrokerRunState): boolean {
    if (
      state.callsStarted >= this.limits.maxCallsPerRun ||
      state.activeCalls >= this.limits.maxConcurrentCallsPerRun
    ) {
      return false;
    }
    state.callsStarted += 1;
    state.activeCalls += 1;
    return true;
  }

  private getOrCreateRunState(
    context: Pick<
      McpBrokerRequestContext,
      "sessionId" | "runId" | "assignmentId" | "leaseId"
    >,
  ): BrokerRunState | null {
    const key = brokerRunKey(context);
    const existing = this.runStates.get(key);
    if (existing) return existing;
    if (this.runStates.size >= this.limits.maxTrackedRuns) return null;
    const created: BrokerRunState = {
      records: new Map(),
      callsStarted: 0,
      activeCalls: 0,
      outputBytes: 0,
      releaseRequested: false,
    };
    this.runStates.set(key, created);
    return created;
  }

  private listFailure(
    requestId: string,
    error: McpSanitizedError,
  ): McpBrokerListResult {
    return {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId,
      generatedAt: this.now().toISOString(),
      authorizedServerCount: 0,
      tools: [],
      errors: [error],
    };
  }
}

function buildAuthorizedToolSet(
  decisions: readonly {
    readonly candidate: {
      readonly server: McpServerView;
      readonly snapshot: McpConnectionSnapshot;
    };
    readonly granted: boolean;
    readonly error: McpSanitizedError | null;
  }[],
  maxSchemaBytes: number,
  requestId: string,
): AuthorizedToolSet {
  const byName = new Map<string, AuthorizedTool>();
  const collisions = new Set<string>();
  const errors = decisions.flatMap((decision) =>
    decision.error ? [decision.error] : [],
  );
  let authorizedServerCount = 0;
  for (const { candidate, granted } of decisions) {
    if (!granted) continue;
    authorizedServerCount += 1;
    if (candidate.snapshot.serverId !== candidate.server.id) {
      errors.push(mcpBrokerError("protocol_error", false, requestId));
      continue;
    }
    for (const tool of candidate.snapshot.tools) {
      const expectedName = namespaceMcpToolName(
        candidate.server.id,
        tool.toolName,
      );
      if (
        tool.serverId !== candidate.server.id ||
        tool.namespacedName !== expectedName ||
        !isToolSchemaWithinLimit(tool, maxSchemaBytes)
      ) {
        byName.delete(expectedName);
        collisions.add(expectedName);
        collisions.add(tool.namespacedName);
        continue;
      }
      if (collisions.has(tool.namespacedName)) continue;
      if (byName.has(tool.namespacedName)) {
        byName.delete(tool.namespacedName);
        collisions.add(tool.namespacedName);
        continue;
      }
      byName.set(tool.namespacedName, { tool });
    }
  }
  if (collisions.size > 0) {
    errors.push(mcpBrokerError("protocol_error", false, requestId));
  }
  const tools = [...byName.values()]
    .map((entry) => cloneNamespacedTool(entry.tool))
    .sort((left, right) =>
      left.namespacedName.localeCompare(right.namespacedName),
    );
  return { authorizedServerCount, tools, byName, collisions, errors };
}

function isToolSchemaWithinLimit(
  tool: McpNamespacedTool,
  maxSchemaBytes: number,
): boolean {
  try {
    return (
      Buffer.byteLength(canonicalizeMcpJson(tool.inputSchema), "utf8") <=
      maxSchemaBytes
    );
  } catch {
    return false;
  }
}

function cloneNamespacedTool(tool: McpNamespacedTool): McpNamespacedTool {
  const inputSchema = cloneMcpJsonSchema(tool.inputSchema);
  const outputSchema = tool.outputSchema
    ? cloneMcpJsonSchema(tool.outputSchema)
    : undefined;
  return {
    serverId: tool.serverId,
    serverName: tool.serverName,
    toolName: tool.toolName,
    namespacedName: tool.namespacedName,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    annotations: { ...tool.annotations },
    risk: tool.risk,
    effect: normalizeExternalCapabilityEffect(tool.effect),
    requiresApproval: tool.requiresApproval,
  };
}

function cloneMcpJsonSchema(value: McpJsonSchema): McpJsonSchema {
  const cloned = normalizeMcpJsonValue(value);
  if (!isMcpJsonObject(cloned)) {
    throw new Error("MCP JSON object clone returned a non-object value");
  }
  return cloned;
}

function isMcpJsonObject(value: unknown): value is McpJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolResponse(value: unknown): NormalizedToolResponse | null {
  const record = asRecord(value);
  if (
    !record ||
    !Array.isArray(record.content) ||
    (record.isError !== undefined && typeof record.isError !== "boolean")
  ) {
    return null;
  }
  if (record.isError === true) return { isError: true, content: [] };
  try {
    const content = record.content.map(normalizeToolContent);
    if (record.structuredContent !== undefined) {
      content.push({
        type: "json",
        value: normalizeMcpJsonValue(record.structuredContent),
      });
    }
    return { isError: false, content };
  } catch {
    return null;
  }
}

function normalizeToolContent(value: unknown): McpToolResultContent {
  const record = asRecord(value);
  if (record?.type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }
  return { type: "json", value: normalizeMcpJsonValue(value) };
}

function callFailure(
  request: Partial<McpBrokerCallRequest> | unknown,
  error: McpSanitizedError,
): McpBrokerCallResult {
  const record = asRecord(request);
  const context = asRecord(record?.context);
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: safeMcpRequestId(context),
    toolCallId: safeIdentifier(record?.toolCallId) ?? "invalid-tool-call",
    isError: true,
    content: [],
    attachments: [],
    evidence: [],
    error,
  };
}

function withRequestIdentity(
  cached: McpBrokerCallResult,
  request: McpBrokerCallRequest,
): McpBrokerCallResult {
  return cloneBrokerCallResult({
    ...cached,
    requestId: request.context.requestId,
    toolCallId: request.toolCallId,
    ...(cached.error
      ? {
          error: {
            ...cached.error,
            correlationId: request.context.requestId,
          },
        }
      : {}),
  });
}

function cloneBrokerCallResult(
  result: McpBrokerCallResult,
): McpBrokerCallResult {
  return JSON.parse(canonicalizeMcpJson(result)) as McpBrokerCallResult;
}

function sanitizeBrokerCallError(
  error: unknown,
  requestId: string,
): McpSanitizedError {
  if (error instanceof BrokerExecutionAbortedError) {
    return mcpBrokerError(error.code, error.code === "timeout", requestId);
  }
  if (error instanceof McpClientManagerError) {
    return mcpBrokerError(error.code, error.retryable, requestId);
  }
  if (error instanceof McpEvidenceStoreError) {
    return mcpBrokerError(
      error.code === "result_too_large" || error.code === "capacity_exceeded"
        ? "result_too_large"
        : "internal",
      false,
      requestId,
    );
  }
  if (error instanceof BrokerAuditWriteError) {
    return mcpBrokerError("internal", true, requestId);
  }
  if (error instanceof McpApprovalError) {
    return mcpBrokerError(
      error.code === "invalid_request" || error.code === "binding_mismatch"
        ? "invalid_request"
        : "internal",
      false,
      requestId,
    );
  }
  return mcpBrokerError("tool_failed", true, requestId);
}

function sanitizeBrokerOperationError(
  error: unknown,
  requestId: string,
): McpSanitizedError {
  if (error instanceof BrokerExecutionAbortedError) {
    return mcpBrokerError(error.code, error.code === "timeout", requestId);
  }
  return mcpBrokerError("internal", true, requestId);
}

function brokerCallFingerprint(
  request: McpBrokerCallRequest,
  canonicalArguments: string,
): string {
  return createHash("sha256")
    .update(request.context.assignmentId)
    .update("\0")
    .update(request.context.agentPath)
    .update("\0")
    .update(request.context.workflowId ?? "")
    .update("\0")
    .update(request.context.workflowStepId ?? "")
    .update("\0")
    .update(request.namespacedToolName)
    .update("\0")
    .update(canonicalArguments)
    .digest("hex");
}

function toolAuthorizationFingerprint(tool: McpNamespacedTool): string {
  return createHash("sha256")
    .update(
      canonicalizeMcpJson({
        serverId: tool.serverId,
        toolName: tool.toolName,
        namespacedName: tool.namespacedName,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
        annotations: tool.annotations,
        risk: tool.risk,
        effect: tool.effect,
        requiresApproval: tool.requiresApproval,
      }),
    )
    .digest("hex");
}

function approvalDecisionError(
  decision: McpApprovalCoordinatorDecision,
  requestId: string,
): McpSanitizedError {
  switch (decision.outcome) {
    case "denied":
      return mcpBrokerError("approval_denied", false, requestId);
    case "expired":
      return mcpBrokerError("timeout", true, requestId);
    case "cancelled":
    case "interrupted":
      return mcpBrokerError("cancelled", false, requestId);
    default:
      return mcpBrokerError("internal", true, requestId);
  }
}

function brokerRunKey(
  scope: Pick<
    McpBrokerRequestContext,
    "sessionId" | "runId" | "assignmentId" | "leaseId"
  >,
): string {
  return [scope.sessionId, scope.runId, scope.assignmentId, scope.leaseId].join(
    "\0",
  );
}

function brokerCallRecordKey(request: McpBrokerCallRequest): string {
  return request.toolCallId;
}

function positiveBrokerDuration(
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > 60 * 60 * 1_000
  ) {
    throw new Error("MCP approval wait timeout is invalid");
  }
  return resolved;
}

function elapsedMs(nowMs: number, startedAtMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(startedAtMs)) return 0;
  return Math.max(0, Math.min(7 * 24 * 60 * 60 * 1_000, nowMs - startedAtMs));
}

function isGloballyActive(
  server: McpServerView | undefined,
): server is McpServerView {
  return Boolean(server?.enabled && server.status === "connected");
}

function hasSnapshot(value: {
  readonly server: McpServerView;
  readonly snapshot: McpConnectionSnapshot | null;
}): value is {
  readonly server: McpServerView;
  readonly snapshot: McpConnectionSnapshot;
} {
  return value.snapshot !== null;
}

function createBrokerExecutionDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  additionalSignals: readonly AbortSignal[] = [],
): BrokerExecutionDeadline {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = callerSignal
    ? [callerSignal, timeoutSignal, ...additionalSignals]
    : [timeoutSignal, ...additionalSignals];
  return {
    ...(callerSignal ? { callerSignal } : {}),
    expiresAt: Date.now() + timeoutMs,
    // The timeout is always in the list, so a list of one is the timeout alone.
    signal: signals.length === 1 ? timeoutSignal : AbortSignal.any(signals),
  };
}

function addLifecycleSignal(
  execution: BrokerExecutionDeadline,
  lifecycleSignal: AbortSignal,
): BrokerExecutionDeadline {
  const callerSignal = execution.callerSignal
    ? AbortSignal.any([execution.callerSignal, lifecycleSignal])
    : lifecycleSignal;
  return {
    callerSignal,
    expiresAt: execution.expiresAt,
    signal: AbortSignal.any([execution.signal, lifecycleSignal]),
  };
}

function authorizationGuardError(
  guard: McpAuthorizationGuard | undefined,
  requestId: string,
): McpSanitizedError | null {
  const code = guard?.getRevocationCode();
  return code ? mcpBrokerError(code, false, requestId) : null;
}

function brokerExecutionError(
  execution: BrokerExecutionDeadline,
  requestId: string,
): McpSanitizedError {
  const code = execution.callerSignal?.aborted ? "cancelled" : "timeout";
  return mcpBrokerError(code, code === "timeout", requestId);
}

async function awaitBrokerOperation<T>(
  operation: Promise<T>,
  execution: BrokerExecutionDeadline,
): Promise<T> {
  if (execution.signal.aborted) {
    throw new BrokerExecutionAbortedError(
      execution.callerSignal?.aborted ? "cancelled" : "timeout",
    );
  }
  return new Promise<T>((resolve, reject) => {
    const timeoutKeepAlive = setTimeout(
      () => undefined,
      Math.max(1, execution.expiresAt - Date.now()),
    );
    const onAbort = () => {
      cleanup();
      reject(
        new BrokerExecutionAbortedError(
          execution.callerSignal?.aborted ? "cancelled" : "timeout",
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeoutKeepAlive);
      execution.signal.removeEventListener("abort", onAbort);
    };
    execution.signal.addEventListener("abort", onAbort, { once: true });
    if (execution.signal.aborted) {
      onAbort();
      return;
    }
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0-\x1f\x7f]/.test(value)
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}
