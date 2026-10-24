import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { replaceRequiredText } from '../../support/config-rewrite.js'

/** The pair `team-chat-e2e` fixture journeys pin every copied Agent to. */
const PINNED_OPENAI_HEADER = '---\nprovider: openai\nmodel: gpt-5.4-mini\nthinking: low\n---\n'

/**
 * Puts one copied fixture Agent on the direct Anthropic provider lane.
 *
 * Bare `anthropic` has no native tool lane (`domains/mcp/mcp-provider-support.ts`),
 * so a Team member on it is run by the Team child through the provider itself,
 * and each streamed suffix reaches the run's preview as it arrives
 * (`domains/agent-execution/agent-runner.ts`). The endpoint is named in the
 * Agent's own `provider_options`, as one JSON object on one front-matter line;
 * the key never goes in the file and is set in the guarded launch instead.
 * Replaces the pinned OpenAI header, and fails loudly if it is not there.
 */
export async function useDirectAnthropicLane(
  projectRootPath: string,
  agentId: string,
  messagesUrl: string,
): Promise<void> {
  const agentFile = path.join(projectRootPath, 'agents', agentId, `${agentId}.md`)
  const header = [
    '---',
    'provider: anthropic',
    'model: fake-claude-stream',
    'thinking: low',
    `provider_options: ${JSON.stringify({ base_url: messagesUrl })}`,
    '---',
    '',
  ].join('\n')
  await fs.writeFile(
    agentFile,
    replaceRequiredText({
      file: agentFile,
      pattern: PINNED_OPENAI_HEADER,
      replacement: header,
      source: await fs.readFile(agentFile, 'utf8'),
    }),
    'utf8',
  )
}
