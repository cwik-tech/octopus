import type { AcquisitionChallengeType } from '../acquisition/acquisition-types.js'
import type { BrowserErrorCode } from './browser-types.js'

export interface BrowserPageEvidence {
  readonly httpStatus?: number
  readonly title: string
  readonly url: string
  readonly text: string
  readonly elementCount: number
  readonly elements?: readonly BrowserPageElementEvidence[]
  readonly frames?: readonly BrowserPageFrameEvidence[]
  readonly blockCount: number
  readonly hasVisualContent: boolean
}

export interface BrowserPageElementEvidence {
  readonly name: string
  readonly role?: string
  readonly type?: string
}

export interface BrowserPageFrameEvidence {
  readonly title: string
  readonly allowed: boolean
}

export interface ChallengeEvidenceContext {
  readonly httpStatus?: number
  readonly elements?: readonly BrowserPageElementEvidence[]
  readonly frames?: readonly BrowserPageFrameEvidence[]
  readonly hasVisualContent?: boolean
}

export interface BrowserPageProblem {
  readonly code: Extract<
    BrowserErrorCode,
    'access_challenge' | 'access_denied' | 'rate_limited' | 'not_found' | 'empty_content'
  >
  readonly message: string
  /** Present only when `code` is `access_challenge`. */
  readonly challengeType?: AcquisitionChallengeType
}

/**
 * Consent and cookie walls. Asked first, because a consent page routinely also
 * says something about verification, and the wall the reader has to get past is
 * the consent one.
 */
const CONSENT_PATTERNS = [
  /before you continue to (?:youtube|google)/,
  /review (?:and|your) (?:cookie|privacy) (?:choices|settings)/,
  /accept (?:all )?cookies to continue/,
]

/**
 * Continuation walls that demand an account.
 *
 * Deliberately narrow. "You must sign in" and "subscription required" already
 * mean `access-denied` on the direct rung and suppress the host; matching them
 * here would move those pages out of that treatment, which Phase 1 does not do.
 * Only continuation phrasing that no existing rule claims appears here.
 */
const LOGIN_PATTERNS = [
  /(?:sign|log) in to continue/,
  /create (?:a free )?account to continue/,
  /subscribe to continue reading/,
  /this (?:content|article) is for (?:members|subscribers) only/,
]

/**
 * Explicit CAPTCHA prompts.
 *
 * The bare word `captcha` is absent on purpose: an article about CAPTCHAs is
 * ordinary evidence. The word is still enough to *name* a page the gate has
 * already confirmed, which is why it appears in `challengeTypeOf` and not here.
 */
const CAPTCHA_PATTERNS = [
  /(?:complete|solve|pass) the (?:re)?captcha/,
  /(?:re)?captcha (?:verification )?(?:required|failed|challenge)/,
  /i'?m not a robot/,
]

/**
 * Human actions used by visual, audio, slider and puzzle challenges.
 *
 * None is a challenge by itself. Documentation can discuss every one of these
 * controls. The classifier requires restriction language plus evidence that
 * the page is acting as a wall before these actions become a CAPTCHA signal.
 */
const CAPTCHA_INTERACTION_PATTERNS = [
  /\bvisual verification\b/,
  /\baudio verification\b/,
  /\bslide (?:left|right)\b/,
  /\bdrag (?:the )?(?:slider|puzzle)\b/,
  /\b(?:hear|enter|type) (?:the )?(?:code|digits?)\b/,
]

/** Context saying that the requested content is behind the control. */
const RESTRICTION_PATTERNS = [
  /\bverification required\b/,
  /\bsecure your access\b/,
  /\bdetected unusual activity\b/,
  /\bautomated (?:bot )?activity\b/,
  /\byou have been blocked\b/,
  /\baccess (?:has been )?blocked\b/,
]

/** Checks aimed at the browser or the device rather than the person. */
const BROWSER_CHECK_PATTERNS = [
  /checking (?:if the site connection is secure|your browser)/,
  /performing security verification/,
  /attention required[.!]?\s*cloudflare/,
  /enable javascript and cookies to continue/,
  /device verification/,
  /verify your device/,
  /press and hold.*(?:human|confirm)/,
]

/** Human-verification prompts that name no mechanism at all. */
const HUMAN_VERIFICATION_PATTERNS = [
  /unusual traffic from your computer network/,
  /verify (?:that )?you(?:'re| are) (?:a )?human/,
  /confirm you(?:'re| are) (?:a )?human/,
  /complete the security check/,
]

const CHALLENGE_GATE_PATTERNS = [
  ...CONSENT_PATTERNS,
  ...LOGIN_PATTERNS,
  ...CAPTCHA_PATTERNS,
  ...BROWSER_CHECK_PATTERNS,
  ...HUMAN_VERIFICATION_PATTERNS,
]

/**
 * The single challenge gate and taxonomy, shared by every rung.
 *
 * Managed Chrome and the acquisition quality check both have to answer "is this
 * a wall, and which one", and two lists drifted apart once already. Returns
 * `null` for a page that is not a wall.
 *
 * `text` must already be lowercased and whitespace-collapsed.
 */
export function classifyChallenge(
  normalizedText: string,
  context: ChallengeEvidenceContext = {},
): AcquisitionChallengeType | null {
  const elements = context.elements ?? []
  const frames = context.frames ?? []
  const elementText = elements
    .map((element) => `${element.role ?? ''} ${element.type ?? ''} ${element.name}`)
    .join(' ')
  const allowedFrameTitles = frames
    .filter((frame) => frame.allowed)
    .map((frame) => frame.title)
    .join(' ')
  const combinedText = normalize(`${normalizedText}\n${elementText}\n${allowedFrameTitles}`)
  const interaction = matches(CAPTCHA_INTERACTION_PATTERNS, combinedText)
  const restriction = matches(RESTRICTION_PATTERNS, combinedText)
  const deniedStatus = context.httpStatus === 401 || context.httpStatus === 403
  const interactiveControl = elements.some((element) =>
    element.role === 'slider' ||
    matches(CAPTCHA_INTERACTION_PATTERNS, normalize(element.name)),
  )
  const challengeFrame = frames.some((frame) =>
    frame.allowed && matches(RESTRICTION_PATTERNS, normalize(frame.title)),
  )
  const interactiveCaptcha =
    interaction &&
    restriction &&
    (deniedStatus || interactiveControl || challengeFrame || context.hasVisualContent === true)
  if (
    !interactiveCaptcha &&
    !CHALLENGE_GATE_PATTERNS.some((pattern) => pattern.test(combinedText))
  ) {
    return null
  }
  return challengeTypeOf(combinedText, interactiveCaptcha)
}

function challengeTypeOf(
  text: string,
  interactiveCaptcha: boolean,
): AcquisitionChallengeType {
  if (matches(CONSENT_PATTERNS, text)) return 'consent-wall'
  if (matches(LOGIN_PATTERNS, text)) return 'login-wall'
  if (
    interactiveCaptcha ||
    matches(CAPTCHA_PATTERNS, text) ||
    /\b(?:re)?captcha\b/.test(text)
  ) {
    return 'captcha'
  }
  if (matches(BROWSER_CHECK_PATTERNS, text)) return 'browser-verification'
  return 'unknown'
}

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * What the agent is told it met.
 *
 * The agent chooses its next move from this sentence, so calling a cookie
 * banner or a paywall a CAPTCHA sends it to wait or retry where it should look
 * elsewhere. Every message keeps the part that does not vary: the page is not
 * usable evidence.
 */
export function challengeMessage(challengeType: AcquisitionChallengeType): string {
  switch (challengeType) {
    case 'captcha':
      return 'The source presented a CAPTCHA. Its content is not usable evidence; prefer another source.'
    case 'browser-verification':
      return 'The source presented a browser or device verification page. Its content is not usable evidence; prefer another source.'
    case 'consent-wall':
      return 'The source presented a cookie or privacy consent wall. Its content is not usable evidence; prefer another source.'
    case 'login-wall':
      return 'The source presented a sign-in or subscription wall. Its content is not usable evidence; prefer another source.'
    case 'unknown':
      return 'The source presented a verification page this reader cannot name. Its content is not usable evidence; prefer another source.'
  }
}

export function classifyBrowserPage(evidence: BrowserPageEvidence): BrowserPageProblem | null {
  const pageText = normalize(`${evidence.title}\n${evidence.text}`)
  const challengeType = classifyChallenge(pageText, {
    ...(evidence.httpStatus === undefined ? {} : { httpStatus: evidence.httpStatus }),
    elements: evidence.elements ?? [],
    frames: evidence.frames ?? [],
    hasVisualContent: evidence.hasVisualContent,
  })
  if (challengeType) {
    return {
      code: 'access_challenge',
      message: challengeMessage(challengeType),
      challengeType,
    }
  }
  if (evidence.httpStatus === 429) {
    return {
      code: 'rate_limited',
      message: 'The source rate-limited browser access. Do not retry this host during this turn; use another source.',
    }
  }
  if (evidence.httpStatus === 401 || evidence.httpStatus === 403) {
    return {
      code: 'access_denied',
      message: `The source denied browser access with HTTP ${evidence.httpStatus}. Do not retry this host during this turn; use another source.`,
    }
  }
  if (evidence.httpStatus === 404 || evidence.httpStatus === 410) {
    return {
      code: 'not_found',
      message: `The source returned HTTP ${evidence.httpStatus}. Use a different page or source.`,
    }
  }
  if (
    evidence.text.trim().length === 0 &&
    evidence.elementCount === 0 &&
    evidence.blockCount === 0 &&
    !evidence.hasVisualContent
  ) {
    return {
      code: 'empty_content',
      message: 'The page produced no usable text, controls, or visual evidence after loading. Use another page or source.',
    }
  }
  return null
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}
