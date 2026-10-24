/**
 * Small helpers the MCP tools and the attention service share: REST paths that
 * cannot leave their route, spoken refusals, and the spoken opening of a text.
 */
import * as z from 'zod/v4'
import { readAgentProviderOptions } from '../../parsers/load-agent.js'

import type { AppMcpToolResult } from './app-mcp-endpoint.js'
import type { LoopbackRestClient, RestResponse } from './loopback-rest-client.js'

/** Validate catalog IDs and provider settings before a voice call creates a chat. */
export async function validateAgentIds(rest: LoopbackRestClient, names: readonly string[], signal: AbortSignal): Promise<AppMcpToolResult | undefined> {
  const response = await rest.request('GET', '/create/agents', { signal })
  const parsed = z.object({ agents: z.array(z.object({ name: z.string() })) }).safeParse(response.body)
  if (response.status !== 200 || !parsed.success) return failure(response, 'check the Agents')
  const available = new Set(parsed.data.agents.map((agent) => agent.name))
  const unknown = names.filter((name) => !available.has(name))
  if (unknown.length > 0) return { summary: `Unknown Agent ID: ${unknown.join(', ')}. Use the names returned by list_agents.`, structured: { status: 400, code: 'unknown_agent', agents: unknown }, isError: true }
  // Sequential: a dialogue admits at most five Agents, and every read shares
  // the caller's deadline. Use the runtime's parser rather than a second policy.
  for (const name of names) {
    const detail = await rest.request('GET', `/create/agents/${pathSegment(name)}`, { signal })
    const agent = z.object({ frontmatter: z.record(z.string(), z.string()) }).safeParse(detail.body)
    if (detail.status !== 200 || !agent.success) return failure(detail, 'check the Agent configuration')
    if (readAgentProviderOptions(agent.data.frontmatter.provider_options).diagnostics.length > 0) {
      return { summary: `Agent ${name} has unusable provider settings. Correct its configuration before starting.`, structured: { status: 400, code: 'invalid_agent_configuration', agent: name }, isError: true }
    }
  }
  return undefined
}

/** Only the store can atomically decide whether a new chat still has no work. */
export async function discardEmptyCreatedSession(rest: LoopbackRestClient, sessionId: string, signal: AbortSignal): Promise<void> {
  await rest.request('DELETE', `${sessionPath(sessionId)}?onlyIfEmpty=true`, { signal })
}

export function sessionPath(sessionId: string, ...rest: readonly string[]): string {
  return ['/sessions', sessionId, ...rest].map((part, index) =>
    index === 0 ? part : pathSegment(part),
  ).join('/')
}

/** One encoded path segment. A dot segment would be resolved, so it is refused. */
export function pathSegment(value: string): string {
  if (value === '.' || value === '..' || value === '') {
    throw new Error('Refused a path segment that is empty or a dot segment.')
  }
  return encodeURIComponent(value)
}

/** How much of a text is looked at for its spoken opening. */
const SPOKEN_SCAN_CHARACTERS = 2_000
/** The longest spoken opening. */
const MAX_SPOKEN_OPENING = 300

/**
 * The opening one or two sentences, for reading aloud. Only the start of the
 * text is scanned, once and without backtracking, so a long report with no
 * sentence breaks costs the same as a short one.
 */
export function openingSentences(text: string): string {
  const prose = text
    .slice(0, SPOKEN_SCAN_CHARACTERS)
    .split('\n')
    .filter((line) => !/^\s*(#|---|```|\|)/.test(line))
    .join(' ')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let end = -1
  let found = 0
  for (let index = 0; index < prose.length && found < 2; index += 1) {
    const character = prose[index]
    if (character !== '.' && character !== '!' && character !== '?') continue
    const next = prose[index + 1]
    if (next === undefined || next === ' ') {
      end = index + 1
      found += 1
    }
  }
  const opening = end === -1 ? prose : prose.slice(0, end)
  return opening.length <= MAX_SPOKEN_OPENING
    ? opening
    : `${opening.slice(0, MAX_SPOKEN_OPENING - 1).trimEnd()}…`
}

/** `text` cut to at most `max` characters, ending in an ellipsis when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export function notFound(summary: string): AppMcpToolResult {
  return { summary, structured: { status: 404 }, isError: true }
}

/**
 * A refusal from the route, passed on in words. The route's own `error` text
 * is user-facing already; nothing else from the body is repeated.
 */
export function failure(response: RestResponse, action: string): AppMcpToolResult {
  const message = errorMessage(response.body)
  return {
    summary: message === undefined
      ? `I couldn't ${action}.`
      : `I couldn't ${action}: ${message}`,
    structured: { status: response.status, ...(message === undefined ? {} : { error: message }) },
    isError: true,
  }
}

function errorMessage(body: unknown): string | undefined {
  const parsed = z.object({ error: z.string(), detail: z.string().optional() }).safeParse(body)
  if (!parsed.success) return undefined
  return parsed.data.detail === undefined
    ? parsed.data.error
    : `${parsed.data.error}. ${parsed.data.detail}`
}
