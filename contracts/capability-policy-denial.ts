/**
 * The refusals the Team Runtime can return instead of running a tool call.
 *
 * A closed list, shared rather than duplicated, because two layers have to
 * agree on it: the gates that decide a tool call may not run, and the surface
 * that has to tell a person why. The refusal's own `reason` never travels that
 * far — it names tools, levels, agents and turn numbers, which is what an
 * engineer reading a log wants and what a reader watching a run cannot use — so
 * the code is the whole of what crosses, and the copy below is this build's.
 *
 * Three gates produce these, and the split below is theirs. The capability
 * policy evaluates a registered tool against the live stage and agent
 * (`team-runtime/capability-tool-policy.ts`). The bypass detector runs earlier
 * and refuses a call the policy never sees, because the tool Pi resolved is not
 * the one this runtime registered
 * (`team-runtime/capability-bypass-detector.ts`). The governed Pi tools refuse
 * on the arguments themselves, inside the tool adapter
 * (`team-runtime/governed-pi-tools.ts`). A reader is shown a sentence whichever
 * one said no; the three lists exist so a code cannot be claimed by a gate that
 * cannot emit it, and each gate narrows its own denial type to its own list, so
 * inventing a code without copy is a type error rather than a bare identifier
 * on someone's screen.
 */
export const CAPABILITY_POLICY_DENIAL_CODES = [
  'unknown_team_runtime_capability',
  'runtime_owned_tool_denied',
  'post_advance_tool_denied',
  'tool_not_allowed_in_level',
  'tool_not_allowed_for_agent',
  'duplicate_level_tool',
] as const

export type CapabilityPolicyDenialCode =
  (typeof CAPABILITY_POLICY_DENIAL_CODES)[number]

/** The refusals the bypass detector returns before any policy runs. */
export const TOOL_BYPASS_REFUSAL_CODES = [
  'ungoverned_tool_call',
  'shadowed_tool_registration',
] as const

export type ToolBypassRefusalCode = (typeof TOOL_BYPASS_REFUSAL_CODES)[number]

/**
 * The refusals the governed Pi tools return on safety grounds.
 *
 * A different kind from the rest. Every other refusal here is a consequence of
 * how the team is configured, and its sentence can name the setting that would
 * change the answer. These two are the runtime declining to do something
 * dangerous whatever the configuration says, so their sentences say that
 * instead of sending a reader off to find a setting that does not exist.
 */
export const TOOL_SAFETY_REFUSAL_CODES = [
  'unsafe_bash_command',
  'tool_path_outside_workspace',
] as const

export type ToolSafetyRefusalCode = (typeof TOOL_SAFETY_REFUSAL_CODES)[number]

/** Every refusal a reader can be shown, from whichever gate produced it. */
export const TOOL_REFUSAL_CODES = [
  ...CAPABILITY_POLICY_DENIAL_CODES,
  ...TOOL_BYPASS_REFUSAL_CODES,
  ...TOOL_SAFETY_REFUSAL_CODES,
] as const

export type ToolRefusalCode =
  | CapabilityPolicyDenialCode
  | ToolBypassRefusalCode
  | ToolSafetyRefusalCode

/**
 * What a person is told when the runtime refuses a tool call.
 *
 * Each line says what the runtime did, and then either names the one setting
 * that would change the answer or says plainly that nothing is needed. None of
 * them names a tool, a stage or an agent: the row already carries who asked for
 * what, and repeating it here would push the sentence past a glance.
 *
 * Every sentence is pinned literally in `tests/unit/capability-policy-denial-copy.test.ts`,
 * so changing one is a deliberate act with a visible diff rather than something
 * a shape check waves through.
 */
export const CAPABILITY_DENIAL_USER_MESSAGES: Readonly<
  Record<ToolRefusalCode, string>
> = {
  // Not "the team has not been given this tool": the reachable cause is that
  // the run has moved on from the stage that offered it. `registerLevelTools`
  // clears and refills the registrations whenever a level is armed
  // (`team-runtime/index.ts:1218`), including mid-turn from an advance
  // (`team-runtime/level-lifecycle.ts:650`) and from `/team-advance` and
  // `/team-reset` (`team-runtime/commands.ts:183`, `:262`), while the
  // dispatcher re-evaluates this policy again before it executes
  // (`core/capability-dispatcher.ts:1222`).
  unknown_team_runtime_capability:
    'This tool is not set up in the stage the run is on now, so the call was turned down. Check which stage offers the tool, or leave the step to that stage.',
  // "Nothing to change here" is honest because only one condition reaches
  // this branch. The lookup behind it returns nothing both for a stage that
  // names no coordinator and for a stage that names one the team does not
  // have (`team-runtime/index.ts:1172-1177`) — but the second never gets as
  // far as a tool call: a level declaring a coordinator that is not a loaded
  // agent is a boot-time config error over every level, and the run does not
  // start (`domains/provider/provider-preflight.ts:150`,
  // `team-runtime/index.ts:1114-1139`). Pinned by 'a level whose declared
  // coordinator never loaded stops the team before it starts' in
  // `tests/unit/provider-preflight.test.ts`.
  runtime_owned_tool_denied:
    'No agent is in charge of this stage, so the run handles it alone and accepts no tool calls. Nothing to change here.',
  post_advance_tool_denied:
    'The run had already moved to the next stage, so the request arrived too late. The work carries on in the new stage.',
  tool_not_allowed_in_level:
    'The agent asked for something this stage does not offer. Add the tool to this stage, or move the step to the stage that already has it.',
  tool_not_allowed_for_agent:
    'This agent is not set up to use that tool. Grant it to the agent, or leave the step to the teammate who already has it.',
  duplicate_level_tool:
    'The agent reached for the same stage tool twice in one turn. The first use counted and the repeat was dropped.',
  ungoverned_tool_call:
    'The agent asked for a tool this run does not offer at all, so nothing ran. Add it to the team and the stage, or drop it from the agent instructions.',
  shadowed_tool_registration:
    'Another part of the app is holding this tool name, so the run refused the call rather than hand it to a tool it does not control. No team setting causes this one.',
  // The two safety refusals. Every other sentence here describes a consequence
  // of the configuration, so it can send a reader to a setting or tell them
  // there is none. These two describe a limit no setting reaches, and naming
  // one would read as an invitation to turn the limit off. Each says what the
  // agent asked for, that nothing happened, and who held the line.
  unsafe_bash_command:
    'The command the agent asked to run could delete files, take administrator rights or run something downloaded from the web, so the run stopped it. This is the runtime keeping your machine safe, not a setting to change.',
  tool_path_outside_workspace:
    'The agent reached for a file outside the folder this run owns, so nothing was read or written. This is the runtime keeping the run inside its own folder, not a setting to change.',
}

/**
 * What a person is told when the runtime refuses with a code this build has no
 * copy for. A build can be older than the runtime writing its events, and a
 * reader shown a bare identifier learns nothing; this at least names the shape
 * of the problem and where the setting lives.
 */
const UNRECOGNISED_DENIAL_MESSAGE =
  'The run turned down a tool the agent asked for. Check the tool settings for this team.'

/** Whether a value is one of the refusal codes this build declares copy for. */
export function isToolRefusalCode(value: unknown): value is ToolRefusalCode {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(CAPABILITY_DENIAL_USER_MESSAGES, value)
}

/**
 * The sentence for a refusal code, including one this build does not know.
 * Never returns the code itself, so a caller can render the result directly.
 */
export function capabilityDenialUserMessage(code: unknown): string {
  return isToolRefusalCode(code)
    ? CAPABILITY_DENIAL_USER_MESSAGES[code]
    : UNRECOGNISED_DENIAL_MESSAGE
}
