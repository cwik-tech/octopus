/**
 * The runtime brief a Team chat turn hands to its child Team runtime.
 *
 * One document carries two kinds of text: what the user wrote, quoted so the
 * lead can read it, and what the runtime knows, written so the runtime can read
 * it back on the next turn. A reader that cannot tell them apart lets anyone
 * name their own roster by typing it, so the boundary between them is a
 * contract rather than a formatting convention.
 *
 * The runtime writes its half inside an explicit frame, and the frame declares
 * the length of the user's half rather than a delimiter to search for:
 *
 * ```
 * <!-- team-chat-brief:v1 message-lines=5 -->
 * # Current user message
 *
 * <exactly the declared number of lines, quoted verbatim>
 *
 * # Conversation continuity
 *
 * Previous responders: ...
 * Standing roster: ...
 * <!-- /team-chat-brief:v1 -->
 * ```
 *
 * Why a length and not a delimiter. Every delimiter is text a user can type.
 * Scoping to the rendered brief's `## User Brief` section looked exact, but
 * `## Uploaded File Context` is itself just a heading, so a user who wrote that
 * line ended the section early: the rest of their message was discarded and the
 * roster written after it disappeared with it. Any rule of the form "stop at
 * the next X" has that shape. A declared length has no such rule — the reader
 * consumes the stated number of lines and stops, whatever they contain.
 *
 * Why the frame itself cannot be forged. The frame opens before the message,
 * and nothing user-controlled precedes the runtime brief in a rendered task
 * brief: `buildTaskBrief` writes `# Task Brief`, the workflow identifier, and
 * `## User Brief` ahead of it, all machine-written. So the first frame-begin
 * line in the document is always the runtime's, and a frame-begin or frame-end
 * line the user types lands inside the counted message and stays text.
 *
 * Quoted history is still flattened to one logical line per message, so the
 * runtime's own half cannot be made to carry a heading or a metadata line
 * either.
 *
 * A document that opens a v1 frame is read as v1 or not at all. If the frame
 * does not parse, or never closes, the answer is `null` rather than a second
 * attempt under the older rules — a document that has already contradicted its
 * own declared shape should not be re-read until one interpretation yields
 * something.
 *
 * Briefs written before the frame existed are already on disk. They open no
 * frame, so they are read by the legacy path below, which keeps the
 * section-scoped rules those briefs were written under. That path is
 * unreachable for anything the runtime writes now.
 */

/** Opens the verbatim user message. */
export const TEAM_CHAT_CURRENT_MESSAGE_HEADING = '# Current user message'

/** Opens the runtime-owned continuity block, and closes the user message. */
export const TEAM_CHAT_CONTINUITY_HEADING = '# Conversation continuity'

/** The roster a team-chat conversation has already established. */
export const STANDING_ROSTER_BRIEF_LABEL = 'Standing roster'

/** Opens the runtime frame and declares how many lines the message occupies. */
export const TEAM_CHAT_BRIEF_FRAME_BEGIN_PREFIX = '<!-- team-chat-brief:v1 '

/** Closes the runtime frame. */
export const TEAM_CHAT_BRIEF_FRAME_END = '<!-- /team-chat-brief:v1 -->'

/**
 * The only `##` headings a rendered task brief emits around the runtime brief
 * (`services/task-service.ts`). A section may be ended only by one of these,
 * because the brief's body is user content and carries `##` headings of its own.
 */
const TASK_BRIEF_SECTION_HEADINGS = ['User Brief', 'Uploaded File Context'] as const

export interface TeamChatRuntimeBriefSections {
  /** Exactly what the user sent this turn. */
  readonly currentMessage: string
  /** Only what the runtime wrote about the conversation so far. */
  readonly continuity: string
  /** Reference text after the closed frame, never runtime-owned metadata. */
  readonly referenceContext?: string
}

/** The frame line a writer emits for a message block of `messageLines` lines. */
export function teamChatBriefFrameBegin(messageLines: number): string {
  if (!Number.isInteger(messageLines) || messageLines < 0) {
    throw new Error('A team chat brief frame needs a non-negative line count.')
  }
  return `${TEAM_CHAT_BRIEF_FRAME_BEGIN_PREFIX}message-lines=${messageLines} -->`
}

/**
 * True for any line a reader of this document would treat as structure.
 *
 * Both readers, not just the framed one. `readLegacySections` keys on the
 * message and continuity headings, so quoting only the frame markers leaves the
 * legacy path forgeable.
 */
function isReaderOwnedLine(line: string): boolean {
  const trimmed = line.trim()
  return isTeamChatBriefFrameLine(line) ||
    trimmed === TEAM_CHAT_CURRENT_MESSAGE_HEADING ||
    trimmed === TEAM_CHAT_CONTINUITY_HEADING
}

/** True for any line the runtime frame owns, in either direction. */
export function isTeamChatBriefFrameLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === TEAM_CHAT_BRIEF_FRAME_END ||
    trimmed.startsWith(TEAM_CHAT_BRIEF_FRAME_BEGIN_PREFIX)
}

/**
 * Join a runtime brief with this turn's carried results, safely.
 *
 * Carried results are a previous run's text: model-written, user-influenced and
 * reproduced verbatim. Placing them ahead of the brief breaks the one premise
 * the frame rests on — that nothing user-controlled precedes it — because the
 * reader takes the *first* frame-begin line in the document. A carried result
 * containing the five frame lines then declares its own message length and its
 * own standing roster, and the real user message is discarded with it.
 * Indenting the carried text is no defence: the reader trims each line before
 * matching.
 *
 * So the carried text goes after the closed frame, which is also where the
 * Workflow launch path already puts it, and every line either reader treats as
 * its own is quoted. Frame lines are the framed reader's; the message and
 * continuity headings are the legacy reader's, which takes the *last*
 * continuity heading in the document rather than the first — so on an unframed
 * brief, carried text carrying that heading and a roster line would otherwise
 * win. Quoting both sets is what makes the guarantee hold whether or not the
 * brief it follows is framed.
 *
 * The text still reaches the model in full; it simply can no longer be read
 * back as runtime state.
 */
export function composeTeamChatBriefWithCarriedContext(
  runtimeBrief: string,
  carriedContext: string | undefined,
): string {
  if (!carriedContext) return runtimeBrief
  const quoted = carriedContext
    .split(/\r?\n/)
    .map((line) => (isReaderOwnedLine(line) ? `> ${line.trim()}` : line))
    .join('\n')
  return `${runtimeBrief}\n\n${quoted}`
}

/**
 * Split a brief into its user half and its runtime half, or answer `null`.
 *
 * `null` means this is not a runtime brief — a plain prompt, or a rendered
 * document whose structure was lost. Callers decide what that means for them;
 * none of them may fall back to scanning the whole document for metadata.
 */
export function readTeamChatRuntimeBriefSections(
  brief: string,
): TeamChatRuntimeBriefSections | null {
  const lines = brief.split(/\r?\n/)
  const frameIndex = lines.findIndex((line) =>
    line.trim().startsWith(TEAM_CHAT_BRIEF_FRAME_BEGIN_PREFIX))
  // A document that opens a v1 frame is read as v1 or not at all. Re-reading a
  // broken frame under the older rules would mean taking whichever of two
  // interpretations happens to produce an answer, on a document that has
  // already shown it is not what it claims to be.
  if (frameIndex !== -1) return readFramedSections(lines, frameIndex)
  return readLegacySections(lines)
}

/**
 * Read the framed form, where both boundaries are declared rather than searched.
 *
 * `frameIndex` is the first frame-begin line, which is the runtime's because
 * nothing user-controlled precedes the runtime brief. From there every position
 * is arithmetic: the heading, the counted message block, and the continuity
 * heading that must follow it exactly.
 *
 * The closing marker is required. Without it the runtime's half would have no
 * stated end, and everything after it in a rendered task brief — the uploaded
 * file section, which is user content — would be read as runtime state. A frame
 * that does not close is a frame that did not survive intact, so it is refused.
 */
function readFramedSections(
  lines: readonly string[],
  frameIndex: number,
): TeamChatRuntimeBriefSections | null {
  const messageLines = readFrameMessageLines(lines[frameIndex] ?? '')
  if (messageLines === null) return null
  if (lines[frameIndex + 1]?.trim() !== TEAM_CHAT_CURRENT_MESSAGE_HEADING) {
    return null
  }
  const messageStart = frameIndex + 2
  const messageEnd = messageStart + messageLines
  if (lines[messageEnd]?.trim() !== TEAM_CHAT_CONTINUITY_HEADING) return null
  const frameEnd = lines.findIndex((line, index) =>
    index > messageEnd && line.trim() === TEAM_CHAT_BRIEF_FRAME_END)
  if (frameEnd === -1) return null
  const referenceContext = lines.slice(frameEnd + 1).join('\n').trim()
  return {
    currentMessage: lines.slice(messageStart, messageEnd).join('\n').trim(),
    continuity: lines.slice(messageEnd + 1, frameEnd).join('\n'),
    ...(referenceContext ? { referenceContext } : {}),
  }
}

function readFrameMessageLines(line: string): number | null {
  const match = line.trim().match(
    /^<!-- team-chat-brief:v1 message-lines=(\d{1,9}) -->$/,
  )
  const declared = match?.[1]
  if (declared === undefined) return null
  return Number.parseInt(declared, 10)
}

/**
 * Read a brief written before the frame existed.
 *
 * Kept because task records already on disk carry this form and must stay
 * readable. Its boundary rules are the ones those briefs were written under:
 * the runtime's continuity heading is the last one inside the rendered brief's
 * `## User Brief` section. That is exact for the documents it is used on and is
 * still not a whole-document scan, but it is the rule the frame replaces,
 * because `## Uploaded File Context` is a line a user can type.
 */
function readLegacySections(
  lines: readonly string[],
): TeamChatRuntimeBriefSections | null {
  const window = resolveUserBriefWindow(lines)
  const messageIndex = window.findIndex(
    (line) => line.trim() === TEAM_CHAT_CURRENT_MESSAGE_HEADING,
  )
  if (messageIndex === -1) return null
  const continuityIndex = window.reduce(
    (found, line, index) =>
      index > messageIndex && line.trim() === TEAM_CHAT_CONTINUITY_HEADING
        ? index
        : found,
    -1,
  )
  if (continuityIndex === -1) return null
  return {
    currentMessage: window.slice(messageIndex + 1, continuityIndex).join('\n').trim(),
    continuity: window.slice(continuityIndex + 1).join('\n'),
  }
}

/** The roster the runtime recorded, read only from the runtime's own block. */
export function readStandingRosterFromContinuity(continuity: string): string[] {
  const label = `${STANDING_ROSTER_BRIEF_LABEL}:`
  const line = continuity
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(label))
  const names = line?.slice(label.length).trim()
  if (!names) return []
  return [
    ...new Set(
      names.split(',')
        .map((agentName) => agentName.trim())
        .filter((agentName) => agentName.length > 0),
    ),
  ]
}

/**
 * Flatten one historical message into a single logical line.
 *
 * The truncation that follows is applied to the flattened text, so a message
 * cut short cannot leave a dangling heading behind either.
 */
export function flattenTeamChatHistoryText(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim()
}

function resolveUserBriefWindow(lines: readonly string[]): readonly string[] {
  const sectionPattern = /^##\s+(.+?)\s*$/
  const startIndex = lines.findIndex((line) => {
    const heading = sectionPattern.exec(line.trim())?.[1]
    return heading?.toLowerCase() === 'user brief'
  })
  if (startIndex === -1) return lines
  const rest = lines.slice(startIndex + 1)
  const endIndex = rest.findIndex((line) => {
    const heading = sectionPattern.exec(line.trim())?.[1]?.toLowerCase()
    return heading !== undefined &&
      TASK_BRIEF_SECTION_HEADINGS.some(
        (candidate) => candidate.toLowerCase() === heading,
      )
  })
  return endIndex === -1 ? rest : rest.slice(0, endIndex)
}
