import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent'

import type { ToolBypassRefusalCode } from '../contracts/capability-policy-denial.js'

export interface TeamRuntimeObservedToolCall {
  readonly toolName: string
  readonly toolCallId: string
}

/**
 * A refusal this detector returns, and the code a reader is told it by.
 *
 * The code travels beside Pi's own block result rather than inside it: the
 * `reason` names the tool and the registration state, which is what a log
 * wants, and a person watching the run needs the sentence that code selects
 * (`contracts/capability-policy-denial.ts`). Carrying only the reason is what
 * let this gate's refusals reach the timeline as "failed using tool".
 */
export interface TeamRuntimeBypassRefusal {
  readonly code: ToolBypassRefusalCode
  readonly result: ToolCallEventResult
}

export interface TeamRuntimeCapabilityBypassDetectorOptions {
  isGovernedRegistrationActive?(toolName: string): boolean
}

/** Residual Pi observer: detection only; dispatcher owns every policy gate. */
export class TeamRuntimeCapabilityBypassDetector {
  private governedToolNames = new Set<string>()

  constructor(
    private readonly options: TeamRuntimeCapabilityBypassDetectorOptions = {},
  ) {}

  replaceGovernedTools(toolNames: Iterable<string>): void {
    this.governedToolNames = new Set(toolNames)
  }

  observe(
    event: TeamRuntimeObservedToolCall,
  ): TeamRuntimeBypassRefusal | undefined {
    if (!this.governedToolNames.has(event.toolName)) {
      return {
        code: 'ungoverned_tool_call',
        result: {
          block: true,
          terminate: true,
          reason: `Tool '${event.toolName}' has no Team Runtime capability registration.`,
        },
      }
    }
    if (!isActiveGovernedRegistration(this.options, event.toolName)) {
      return {
        code: 'shadowed_tool_registration',
        result: {
          block: true,
          terminate: true,
          reason:
            `Tool '${event.toolName}' is not the active Team Runtime ` +
            'capability registration.',
        },
      }
    }
    return undefined
  }
}

function isActiveGovernedRegistration(
  options: TeamRuntimeCapabilityBypassDetectorOptions,
  toolName: string,
): boolean {
  try {
    return options.isGovernedRegistrationActive?.(toolName) !== false
  } catch {
    return false
  }
}
