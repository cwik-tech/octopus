import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

import {
  DEEP_RESEARCH_UNVALIDATED_SENTENCE,
  DEEP_RESEARCH_UNVALIDATED_URL,
} from './deep-research-fixture-constants.mjs'

const EXPECTED_MARKER = 'provider-loop-marker'
const DEEP_RESEARCH_SCENARIO =
  process.env.PIPELINE_DEEP_RESEARCH_FIXTURE_SCENARIO ?? 'approve'
// Optional test hooks for the Run UI smoke journey: when
// PROVIDER_FIXTURE_REQUEST_LOG is set, every /v1/responses or
// /v1/chat/completions request body is appended to that file as one JSON line,
// and the fixture/echo-sentinel model answers with a Receptionist-shaped decision
// that echoes the first match of PROVIDER_FIXTURE_SENTINEL_PATTERN found in
// the request text (proving the request carried grounded file context).
const REQUEST_LOG_PATH = process.env.PROVIDER_FIXTURE_REQUEST_LOG
const SENTINEL_PATTERN = process.env.PROVIDER_FIXTURE_SENTINEL_PATTERN
// Fanout script for the governed parallel-execution journey: when the
// fixture/fanout model is requested, PROVIDER_FANOUT_SCRIPT supplies
// { calls: [{ id, name, arguments }], finalText }. The first turn emits all
// calls in one assistant message; any later turn emits finalText.
const FANOUT_SCRIPT = readFanoutScript()
// Tool-bearing requests that ask for `stream: true` are answered as SSE. The
// native tool loop sends one, a tool-free final request, when its caller shows
// the answer live.
const STREAMED_RESPONSES = new WeakSet()
function readFanoutScript() {
  const raw = process.env.PROVIDER_FANOUT_SCRIPT
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (
      Array.isArray(parsed?.calls) &&
      parsed.calls.every((call) =>
        typeof call?.id === 'string' &&
        typeof call?.name === 'string' &&
        isRecord(call?.arguments),
      ) &&
      typeof parsed?.finalText === 'string'
    ) {
      return parsed
    }
  } catch {
    return null
  }
  return null
}
// Both correction scenarios drive one adaptive correction wave. Only
// `fenced-correction` wraps the critic's single verdict in a Markdown fence,
// reproducing a provider that answers well but ignores the requested output
// schema's transport shape.
const DEEP_RESEARCH_CORRECTION_SCENARIO =
  DEEP_RESEARCH_SCENARIO === 'correction' ||
  DEEP_RESEARCH_SCENARIO === 'fenced-correction'
const DEEP_RESEARCH_FENCED_QUALITY_VERDICT =
  DEEP_RESEARCH_SCENARIO === 'fenced-correction'
let deepResearchCorrectionIssued = false
// The multi-section journey a user reaches through Run chat. The plan it
// returns has two sections under `section_dossiers`, so the run exercises the
// section writer, the synthesis budget and assignment-owned quality review
// rather than collapsing to one single-pass draft.
const DEEP_RESEARCH_SECTION_JOURNEY =
  DEEP_RESEARCH_SCENARIO === 'sushi-section-dossiers'
// Local evidence-site URLs, one per planned section. A live planner would
// name URLs it knows; this fixture is told them, because the journey must not
// reach the open web.
const DEEP_RESEARCH_JOURNEY_SOURCE_URLS = readJourneySourceUrls()
function readJourneySourceUrls() {
  const raw = process.env.PIPELINE_DEEP_RESEARCH_FIXTURE_SOURCE_URLS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((url) => typeof url === 'string')
      ? parsed
      : []
  } catch {
    return []
  }
}
const DEEP_RESEARCH_JOURNEY_SECTIONS = [
  {
    id: 'sushi-quality',
    title: 'Sushi quality and menus',
    objective: 'Establish what the downtown Detroit sushi rooms actually serve.',
    taskId: 'T1',
    displayRole: 'Sushi Menu Analyst',
  },
  {
    id: 'sushi-experience',
    title: 'Room, service, and access',
    objective: 'Establish the dining experience each room offers a solo diner.',
    taskId: 'T2',
    displayRole: 'Dining Experience Analyst',
  },
]
// The exact system-prompt lines `withMcpToolRules` in
// services/mcp-worker-turn-service.ts appends to a Deep Research evidence
// turn. They are quoted rather than matched loosely so a reworded rule fails
// instead of drifting silently: this fixture answers on the stage heading
// it finds in the request and used to ignore the injected rules entirely, which
// is how a regression that gave the evidence-turn block to every worker —
// including the section writer and the synthesizer, rostered with no tools —
// passed the whole suite.
// Each of the four is load-bearing for a case in
// tests/integration/deep-research-fixture-prompt-guard.test.ts, which composes
// these lines through the real service rather than quoting them: reword one in
// production without rewording it here and that case turns red. The JSON-only
// rule needs a case of its own, because production writes it inside the same
// block as the acquire rule below and a refusal names the first rule it
// matches.
const MCP_TOOL_RULES_HEADING = 'MCP tool rules:'
const EVIDENCE_TURN_ACQUIRE_RULE =
  '- This is a Deep Research evidence turn. Reach the web through a governed tool before answering; never answer only from memory.'
const EVIDENCE_TURN_JSON_ONLY_RULE =
  'Return only one JSON object matching the response schema, without Markdown or prose.'
const EVIDENCE_TURN_PACKET_CORRECTION_RULE =
  '- This is a bounded Deep Research packet correction. Reuse the runtime-validated evidence supplied in the assignment; a new governed web call is not required.'
// The opening sentence of DEEP_RESEARCH_STABLE_SYSTEM_PROMPT
// (domains/deep-research/deep-research-prompt-envelope.ts), which the pipeline
// appends to the Web Researcher's own prompt for an approved assignment. It is
// what separates a Deep Research evidence turn from the same agent answering
// Quick Scout or Direct Chat, neither of which chooses an evidence mode.
const DEEP_RESEARCH_EVIDENCE_TURN_IDENTITY =
  'You are the trusted web-researcher capability loaded from agents/web-researcher/web-researcher.md.'
// The Deep Research agent headings, each taken from the heading its agent file
// opens with. Every one of these agents answers prose or its own stage object,
// so none of them may carry an evidence-turn rule.
const DEEP_RESEARCH_NON_EVIDENCE_AGENT_HEADINGS = [
  '# Research Planner',
  '# Research Section Writer',
  '# Research Synthesizer',
  '# Evidence Critic',
  '# Research Escalator',
  '# Deep Research Publication Writer',
  '# Deep Research Publication Editor',
]
const MODEL_IDS = [
  'fixture/tool-loop',
  'fixture/auth',
  'fixture/repeated-id',
  'fixture/reused-id-changed',
  'fixture/malformed',
  'fixture/duplicate',
  'fixture/empty-id',
  'fixture/limit',
  'fixture/round-limit',
  'fixture/error',
  'fixture/invalid-json',
  'fixture/oversized',
  'fixture/slow',
  'fixture/truncated',
  'fixture/browser-agent',
  'fixture/browser-research',
  'fixture/browser-research-unsupported',
  'fixture/research-web',
  'fixture/deep-research',
  'fixture/generate-word',
  'fixture/generate-excel',
  'fixture/echo-sentinel',
  'fixture/fanout',
]

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    writeJson(response, 200, {
      object: 'list',
      data: MODEL_IDS.map((id) => ({ id, object: 'model' })),
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/v1/responses') {
    try {
      const body = await readJsonBody(request)
      logRequestBody(body)
      if (typeof body?.model !== 'string' || !Array.isArray(body?.input)) {
        throw new Error('Model and input are required')
      }
      assertDeepResearchPromptMatchesAgent(routedRequestText(body))
      const outputText = body.model === 'fixture/deep-research'
        ? deepResearchTextResponse(responsesInputText(body.input))
        : body.model === 'fixture/generate-word'
          ? generateWordMarkdown()
        : body.model === 'fixture/generate-excel'
          ? generateExcelMarkdown()
        : 'provider-no-tools'
      writeJson(response, 200, {
        id: `fixture-response-${Date.now()}`,
        object: 'response',
        model: body.model,
        output_text: outputText,
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: outputText }],
        }],
        usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
      })
    } catch (error) {
      writeJson(response, 400, {
        error: {
          message: error instanceof Error ? error.message : 'Invalid request',
        },
      })
    }
    return
  }
  if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    writeJson(response, 404, { error: { message: 'Not found' } })
    return
  }

  try {
    const body = await readJsonBody(request)
    logRequestBody(body)
    assertDeepResearchPromptMatchesAgent(routedRequestText(body))
    // These scenarios request no file, dialogue, or progress report.
    // Baseline tools do not require the simulated model to call them. Fanout
    // scripts retain their explicit tool calls.
    if (!Array.isArray(body?.tools) || body.tools.length === 0 ||
      (body.model !== 'fixture/fanout' && body.tools.every((tool) =>
        tool?.function?.name === 'create_file' || tool?.function?.name === 'start_dialogue' || tool?.function?.name === 'report_progress'))) {
      if (typeof body?.model !== 'string' || !Array.isArray(body?.messages)) {
        throw new Error('Model and messages are required')
      }
      if (
        body.model === 'fixture/generate-word' &&
        /Chat will persist your Markdown and run the enabled Generate Word transform/i.test(
          chatMessagesText(body.messages),
        )
      ) {
        writeJson(response, 422, {
          error: {
            message: 'Generate Word was enabled but excluded from the provider tool inventory',
          },
        })
        return
      }
      if (body.model === 'fixture/echo-sentinel') {
        writeCompletion(response, body.model, {
          role: 'assistant',
          content: echoSentinelDecision(chatMessagesText(body.messages)),
        })
        return
      }
      // Run chat asks the receptionist without tools. Answering here is what
      // lets the Deep Research journey start from a typed message rather than
      // from a run plan the test wrote directly.
      if (body.model === 'fixture/deep-research') {
        writeCompletion(response, body.model, {
          role: 'assistant',
          content: deepResearchTextResponse(chatMessagesText(body.messages)),
        })
        return
      }
      writeCompletion(response, body.model, {
        role: 'assistant',
        content: body.model === 'fixture/generate-word'
          ? generateWordMarkdown()
          : body.model === 'fixture/generate-excel'
            ? generateExcelMarkdown()
            : 'provider-no-tools',
      })
      return
    }
    const mode = body.model.replace(/^fixture\//, '')
    if (body.stream === true) STREAMED_RESPONSES.add(response)
    // Document output can be requested while unrelated baseline tools are
    // present. Follow the document contract without calling those tools.
    if (mode === 'generate-excel' || (mode === 'generate-word' &&
      !body.tools.some((tool) => tool?.function?.name === 'generate_word'))) {
      writeCompletion(response, body.model, {
        role: 'assistant',
        content: mode === 'generate-excel' ? generateExcelMarkdown() : generateWordMarkdown(),
      })
      return
    }
    if (mode === 'truncated') {
      // A turn the model stopped emitting at its token ceiling. The tool-loop
      // client must refuse it rather than accept the fragment as a finished
      // assistant turn.
      writeCompletion(response, body.model, {
        role: 'assistant',
        content: 'A partial ans',
      }, 'length')
      return
    }
    if (mode === 'fanout') {
      if (!FANOUT_SCRIPT) throw new Error('Fanout script is missing')
      const hasToolResult = body.messages?.some(
        (message) => message?.role === 'tool',
      )
      if (!hasToolResult) {
        writeToolCalls(response, body.model, FANOUT_SCRIPT.calls.map((call) =>
          toolCall(call.id, call.name, JSON.stringify(call.arguments)),
        ))
        return
      }
      writeCompletion(response, body.model, {
        role: 'assistant',
        content: FANOUT_SCRIPT.finalText,
      })
      return
    }
    if (
      mode === 'deep-research' &&
      !body.tools.some((tool) =>
        tool?.type === 'function' &&
        tool?.function?.name === 'browser'
      )
    ) {
      if (typeof body.model !== 'string' || !Array.isArray(body.messages)) {
        throw new Error('Model and messages are required')
      }
      writeCompletion(response, body.model, {
        role: 'assistant',
        content: deepResearchTextResponse(chatMessagesText(body.messages)),
      })
      return
    }
    const requestShape = validateRequestShape(body, mode)

    if (
      mode === 'auth' &&
      request.headers.authorization !== 'Bearer fixture-api-key'
    ) {
      writeJson(response, 401, { error: { message: 'Invalid fixture key' } })
      return
    }

    if (mode === 'error') {
      writeJson(response, 503, {
        error: { message: 'fixture-private-upstream-detail' },
      })
      return
    }
    if (mode === 'invalid-json') {
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end('{"choices":')
      return
    }
    if (mode === 'oversized') {
      writeCompletion(response, requestShape.model, {
        role: 'assistant',
        content: `oversized:${'x'.repeat(64_000)}`,
      })
      return
    }
    if (mode === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 750))
      if (response.destroyed) return
    }

    const toolMessages = requestShape.messages.filter(
      (message) => message?.role === 'tool',
    )
    const toolName = requestShape.tool.function.name

    if (mode === 'research-web') {
      if (toolName !== 'research_web') {
        throw new Error('Research Web was not exposed to Quick Scout')
      }
      if (toolMessages.length === 0) {
        writeToolCalls(response, requestShape.model, [
          toolCall('call-quick-scout-search', toolName, JSON.stringify({
            action: 'search',
            query: 'ice cream shops in Ann Arbor Michigan',
            maximumResults: 5,
          })),
        ])
        return
      }
      const braveResultsOf = (searchOutput) =>
        Array.isArray(searchOutput?.results)
          ? searchOutput.results.filter((result) => result?.provider === 'brave')
          : []
      if (toolMessages.length === 1 || toolMessages.length === 2) {
        const search = parseJsonToolOutput(toolMessages[0]?.content)
        const braveResults = braveResultsOf(search)
        // The first acquire reads the leading Brave result, the second acquire
        // the next one. The third search candidate is deliberately never
        // acquired: it stays a discovery-only URL so the final answer can cite
        // it and exercise the evidence guard.
        const source = braveResults[toolMessages.length - 1]
        const sourceUrl = source?.canonicalUrl ?? source?.url
        if (search?.ok !== true || typeof sourceUrl !== 'string') {
          throw new Error('Quick Scout did not receive Brave search results')
        }
        writeToolCalls(response, requestShape.model, [
          toolCall(`call-quick-scout-acquire-${toolMessages.length}`, toolName, JSON.stringify({
            action: 'acquire',
            url: sourceUrl,
          })),
        ])
        return
      }
      const firstAcquisition = parseJsonToolOutput(toolMessages[1]?.content)
      const secondAcquisition = parseJsonToolOutput(toolMessages[2]?.content)
      const discoveryOnly = braveResultsOf(
        parseJsonToolOutput(toolMessages[0]?.content),
      )[2]
      const discoveryOnlyUrl = discoveryOnly?.canonicalUrl ?? discoveryOnly?.url
      if (
        firstAcquisition?.ok !== true ||
        typeof firstAcquisition.canonicalUrl !== 'string' ||
        secondAcquisition?.ok !== true ||
        typeof secondAcquisition.canonicalUrl !== 'string' ||
        typeof discoveryOnlyUrl !== 'string'
      ) {
        throw new Error('Quick Scout did not acquire two citable Brave sources')
      }
      // Test hook: when the user message carries TRAILING_INVITATION, the
      // answer ends with a follow-up offer, so the legacy guard's invitation
      // stripping makes the persisted text differ from the streamed candidate.
      const trailingInvitation = requestShape.messages.some(
        (message) =>
          message?.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('TRAILING_INVITATION'),
      )
      writeCompletion(response, requestShape.model, {
        role: 'assistant',
        content: [
          '**Question:** Ice cream shops in Ann Arbor.',
          '**Short Answer:** BRAVE_PATH_CONFIRMED',
          `**Findings:** [Ann Arbor Ice Cream Source](${firstAcquisition.canonicalUrl}) provides current local evidence, [Washtenaw Dairy](${secondAcquisition.canonicalUrl}) confirms it, and [Ann Arbor Observer](${discoveryOnlyUrl}) lists more.`,
          '**Contradictions:** None',
          '**Open Questions:** None',
          '**Next Step:** Stop',
          ...(trailingInvitation
            ? ['If you want, I can compare more Ann Arbor creameries.']
            : []),
        ].join('\n\n'),
      })
      return
    }

    if (mode === 'generate-word') {
      if (toolName !== 'generate_word') {
        throw new Error('Generate Word was not exposed to the provider')
      }
      if (toolMessages.length === 0) {
        writeToolCalls(response, requestShape.model, [
          toolCall('call-generate-word', toolName, JSON.stringify({
            action: 'generate',
            markdown: generateWordMarkdown(),
            outputPath: 'lorem-ipsum-document.docx',
            profile: 'research-report',
          })),
        ])
        return
      }
      const generated = parseJsonToolOutput(toolMessages.at(-1)?.content)
      if (!generated?.ok || generated.outputPath !== 'lorem-ipsum-document.docx') {
        throw new Error('Generate Word result was not supplied to the agent')
      }
      writeCompletion(response, requestShape.model, {
        role: 'assistant',
        content: 'The Word document is attached.',
      })
      return
    }

    if (mode === 'deep-research') {
      const userText = requestShape.messages
        .filter((message) => message?.role === 'user')
        .map((message) => String(message.content ?? ''))
        .join('\n')
      const sourceUrl = userText.match(/Fixture source URL:\s*(https?:\/\/[^\s"}]*[^\s"}.,;:])/i)?.[1]
      if (!sourceUrl) throw new Error('Deep Research fixture source URL is missing')
      if (toolMessages.length === 0) {
        writeToolCalls(response, requestShape.model, [
          toolCall('call-deep-research-source', toolName, JSON.stringify({
            action: 'open',
            url: sourceUrl,
          })),
        ])
        return
      }
      const observation = parseBrowserToolOutput(toolMessages.at(-1)?.content)
      writeCompletion(response, requestShape.model, {
        role: 'assistant',
        content: JSON.stringify(deepResearchEvidencePacket(userText, observation)),
      })
      return
    }

    if (mode === 'browser-research-unsupported') {
      const userText = requestShape.messages
        .filter((message) => message?.role === 'user')
        .map((message) => String(message.content ?? ''))
        .join('\n')
      const firstUrl = userText.match(/First URL:\s*(https?:\/\/\S+)/i)?.[1]
      const secondUrl = userText.match(/Second URL:\s*(https?:\/\/\S+)/i)?.[1]
      if (!firstUrl || !secondUrl) throw new Error('Unsupported research fixture URLs are missing')
      if (toolMessages.length === 0) {
        writeToolCalls(response, requestShape.model, [
          toolCall('call-unsupported-first', toolName, JSON.stringify({ action: 'open', url: firstUrl })),
        ])
        return
      }
      if (toolMessages.length === 1) {
        writeToolCalls(response, requestShape.model, [
          toolCall('call-unsupported-second', toolName, JSON.stringify({ action: 'open', url: secondUrl })),
        ])
        return
      }
      writeCompletion(response, requestShape.model, {
        role: 'assistant',
        content: [
          'HOMES Brewery is the strongest evidence-backed winner.',
          firstUrl,
          secondUrl,
          'If you want, I can rank more breweries.',
        ].join('\n'),
      })
      return
    }

    if (mode === 'browser-research') {
      const userText = requestShape.messages
        .filter((message) => message?.role === 'user')
        .map((message) => String(message.content ?? ''))
        .join('\n')
      const challengeUrl = userText.match(/Challenge URL:\s*(https?:\/\/\S+)/i)?.[1]
      const goodUrl = userText.match(/Good URL:\s*(https?:\/\/\S+)/i)?.[1]
      if (!challengeUrl || !goodUrl) throw new Error('Browser research fixture URLs are missing')
      if (toolMessages.length === 0) {
        writeToolCalls(response, requestShape.model, [
          toolCall('call-research-challenge', toolName, JSON.stringify({ action: 'open', url: challengeUrl })),
        ])
        return
      }
      const previous = parseBrowserToolOutput(toolMessages.at(-1)?.content)
      if (toolMessages.length === 1) {
        if (previous?.error?.code !== 'access_challenge') {
          throw new Error('CAPTCHA was not returned as an access challenge')
        }
        writeToolCalls(response, requestShape.model, [
          toolCall('call-research-repeat', toolName, JSON.stringify({ action: 'open', url: challengeUrl })),
        ])
        return
      }
      if (toolMessages.length === 2) {
        // A challenge no longer bans the host, so the repeat reaches the source
        // and meets the same wall. `source_blocked` here would mean the lane
        // answered from a stored ban instead of executing the call.
        if (previous?.error?.code !== 'access_challenge') {
          throw new Error('The repeated challenged host did not reach the source')
        }
        writeToolCalls(response, requestShape.model, [
          toolCall('call-research-good', toolName, JSON.stringify({ action: 'open', url: goodUrl })),
        ])
        return
      }
      const reportCode = typeof previous?.text === 'string'
        ? previous.text.match(/E2E_REPORT_CODE_[A-Z0-9_]+/)?.[0]
        : undefined
      if (!previous?.ok || !reportCode) {
        throw new Error('Usable fallback source data was not supplied to the researcher')
      }
      writeCompletion(response, requestShape.model, {
        role: 'assistant',
        content: `Verified answer: ${reportCode}\nSource: ${goodUrl}`,
      })
      return
    }

    if (mode === 'browser-agent') {
      const targetUrl = requestShape.messages
        .filter((message) => message?.role === 'user')
        .map((message) => String(message.content ?? ''))
        .join('\n')
        .match(/https?:\/\/[^\s]+/)?.[0]
      if (!targetUrl) throw new Error('Browser fixture target URL is missing')
      if (toolMessages.length === 0) {
        writeToolCalls(response, requestShape.model, [
          toolCall('call-browser-open', toolName, JSON.stringify({ action: 'open', url: targetUrl })),
        ])
        return
      }
      const previous = parseBrowserToolOutput(toolMessages.at(-1)?.content)
      if (toolMessages.length === 1) {
        if (!previous?.ok || typeof previous.pageId !== 'string') {
          throw new Error('Browser open result was not supplied to the agent')
        }
        writeToolCalls(response, requestShape.model, [
          toolCall('call-browser-observe', toolName, JSON.stringify({
            action: 'observe',
            pageId: previous.pageId,
          })),
        ])
        return
      }
      const observed = parseBrowserToolOutput(toolMessages[1]?.content)
      const reportCode = typeof observed?.text === 'string'
        ? observed.text.match(/E2E_REPORT_CODE_[A-Z0-9_]+/)?.[0]
        : undefined
      if (!reportCode) throw new Error('Browser page data was not supplied to the agent')
      if (toolMessages.length === 2) {
        if (typeof observed?.pageId !== 'string') throw new Error('Observed browser page id is missing')
        writeToolCalls(response, requestShape.model, [
          toolCall('call-browser-screenshot', toolName, JSON.stringify({
            action: 'screenshot',
            pageId: observed.pageId,
          })),
        ])
        return
      }
      const receivedImage = requestShape.messages.some((message) =>
        message?.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((part) =>
          part?.type === 'image_url' &&
          typeof part?.image_url?.url === 'string' &&
          /^data:image\/(?:png|jpeg|webp);base64,/.test(part.image_url.url)
        )
      )
      if (!receivedImage) throw new Error('Browser screenshot was not supplied as a visual agent input')
      writeCompletion(response, requestShape.model, {
        role: 'assistant',
        content: `agent-received:${reportCode}`,
      })
      return
    }

    if (mode === 'malformed') {
      writeToolCalls(response, requestShape.model, [
        toolCall('call-malformed', toolName, '{"marker":'),
      ])
      return
    }
    if (mode === 'duplicate') {
      writeToolCalls(response, requestShape.model, [
        toolCall('call-duplicate', toolName, markerArguments(EXPECTED_MARKER)),
        toolCall('call-duplicate', toolName, markerArguments(EXPECTED_MARKER)),
      ])
      return
    }
    if (mode === 'empty-id') {
      writeToolCalls(response, requestShape.model, [
        toolCall('', toolName, markerArguments(EXPECTED_MARKER)),
      ])
      return
    }
    if (mode === 'limit') {
      writeToolCalls(response, requestShape.model, [
        toolCall('call-limit-1', toolName, markerArguments('limit-1')),
        toolCall('call-limit-2', toolName, markerArguments('limit-2')),
        toolCall('call-limit-3', toolName, markerArguments('limit-3')),
      ])
      return
    }
    if (mode === 'round-limit') {
      writeToolCalls(response, requestShape.model, [
        toolCall(
          `call-round-${toolMessages.length + 1}`,
          toolName,
          markerArguments(`round-${toolMessages.length + 1}`),
        ),
      ])
      return
    }
    if (mode === 'reused-id-changed') {
      writeToolCalls(response, requestShape.model, [
        toolCall(
          'call-reused',
          toolName,
          markerArguments(
            toolMessages.length === 0 ? EXPECTED_MARKER : 'changed-marker',
          ),
        ),
      ])
      return
    }
    if (mode === 'repeated-id' && toolMessages.length < 2) {
      writeToolCalls(response, requestShape.model, [
        toolCall(
          'call-repeated',
          toolName,
          markerArguments(EXPECTED_MARKER),
        ),
      ])
      return
    }
    if (toolMessages.length === 0) {
      writeToolCalls(response, requestShape.model, [
        toolCall('call-marker', toolName, markerArguments(EXPECTED_MARKER)),
      ])
      return
    }

    const consumedText = extractToolResultText(toolMessages.at(-1)?.content)
    if (consumedText !== `echo-marker:${EXPECTED_MARKER}`) {
      writeJson(response, 422, {
        error: { message: 'The expected MCP marker result was not supplied' },
      })
      return
    }
    writeCompletion(response, requestShape.model, {
      role: 'assistant',
      content: `provider-consumed:${consumedText}`,
    })
  } catch (error) {
    writeJson(response, 400, {
      error: {
        message: error instanceof Error ? error.message : 'Invalid request',
      },
    })
  }
})

function logRequestBody(body) {
  if (REQUEST_LOG_PATH) {
    appendFileSync(REQUEST_LOG_PATH, `${JSON.stringify(body)}\n`)
  }
}

function validateRequestShape(value, mode) {
  if (!isRecord(value) || typeof value.model !== 'string') {
    throw new Error('Model is required')
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.tools)) {
    throw new Error('Messages and tools are required')
  }
  const browserMode = mode === 'browser-agent'
    || mode === 'browser-research'
    || mode === 'browser-research-unsupported'
    || mode === 'deep-research'
  const generateWordMode = mode === 'generate-word'
  const researchWebMode = mode === 'research-web'
  const tool = value.tools.find(
    (candidate) =>
      candidate?.type === 'function' &&
      isRecord(candidate.function) &&
      typeof candidate.function.name === 'string' &&
      (!browserMode || candidate.function.name === 'browser') &&
      (!researchWebMode || candidate.function.name === 'research_web') &&
      (!generateWordMode || candidate.function.name === 'generate_word'),
  )
  if (!tool) throw new Error('A function tool is required')
  const parameters = tool.function.parameters
  if (browserMode) {
    if (
      !isRecord(parameters) ||
      parameters.type !== 'object' ||
      !isRecord(parameters.properties) ||
      !isRecord(parameters.properties.action) ||
      !Array.isArray(parameters.properties.action.enum) ||
      !parameters.properties.action.enum.includes('observe')
    ) {
      throw new Error('The browser tool schema is not normalized')
    }
  } else if (researchWebMode) {
    if (
      !isRecord(parameters) ||
      parameters.type !== 'object' ||
      !isRecord(parameters.properties) ||
      !isRecord(parameters.properties.action) ||
      !Array.isArray(parameters.properties.action.enum) ||
      !parameters.properties.action.enum.includes('search')
    ) {
      throw new Error('The Research Web tool schema does not expose search')
    }
  } else if (generateWordMode) {
    if (
      !isRecord(parameters) ||
      parameters.type !== 'object' ||
      !isRecord(parameters.properties) ||
      !isRecord(parameters.properties.markdown) ||
      parameters.properties.markdown.type !== 'string'
    ) {
      throw new Error('The Generate Word tool schema does not accept Markdown')
    }
  } else if (
    !isRecord(parameters) ||
    parameters.type !== 'object' ||
    !isRecord(parameters.properties) ||
    !isRecord(parameters.properties.marker) ||
    parameters.properties.marker.type !== 'string' ||
    !Array.isArray(parameters.required) ||
    !parameters.required.includes('marker')
  ) {
    throw new Error('The marker tool schema is not normalized')
  }
  return {
    model: value.model,
    messages: value.messages,
    tool,
  }
}

function parseJsonToolOutput(content) {
  if (typeof content !== 'string') return null
  try {
    const parsed = JSON.parse(content)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function responsesInputText(input) {
  return input
    .flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function chatMessagesText(messages) {
  return messages
    .flatMap((message) => {
      if (typeof message?.content === 'string') return [message.content]
      if (!Array.isArray(message?.content)) return []
      return message.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
    })
    .join('\n')
}

// The exact text each stage routing reads, so the guard below and the routing
// cannot disagree about what a request says. Chat messages carry plain strings
// or `text` parts; the responses input carries `input_text` parts.
function routedRequestText(body) {
  if (Array.isArray(body?.input)) return responsesInputText(body.input)
  if (Array.isArray(body?.messages)) return chatMessagesText(body.messages)
  return ''
}

/**
 * Refuse a Deep Research request whose text contradicts the stage it routes to.
 *
 * A wrong answer given silently is what created the blind spot, so the
 * contradiction leaves here as an HTTP 400 provider error naming what
 * contradicts what: the offending rule and the stage it reached for a
 * non-evidence turn, and which rules an evidence turn carried or lacked for the
 * two evidence-mode refusals. That shape is the point: a Deep Research prompt this
 * fixture cannot route is answered rather than refused — HTTP 200 with the bare
 * text 'NOOP', the fall-through in `deepResearchTextResponse` — and a caller
 * cannot tell that reply from a model with little to say, so a run built on it
 * carries on. A provider error cannot be mistaken for a model answer, so the
 * run stops where the contradiction is.
 *
 * The judged text is the whole request, system prompt and messages together,
 * because that is the string the stage routing answers from: a marker the
 * routing can act on has to be a marker this guard can see. The cost is that an
 * evidence rule quoted into a user message is refused as well, which is the
 * right call for a fixture that reads text and cannot tell who wrote it. Only
 * Deep Research text is judged; every other request passes through untouched.
 */
function assertDeepResearchPromptMatchesAgent(requestText) {
  const agentHeading = DEEP_RESEARCH_NON_EVIDENCE_AGENT_HEADINGS.find(
    (heading) => requestText.includes(heading),
  )
  if (agentHeading) {
    const evidenceRule = [
      EVIDENCE_TURN_ACQUIRE_RULE,
      EVIDENCE_TURN_PACKET_CORRECTION_RULE,
      EVIDENCE_TURN_JSON_ONLY_RULE,
    ].find((rule) => requestText.includes(rule))
    if (evidenceRule) {
      throw new Error(
        `Deep Research prompt contradiction: this request routes to '${agentHeading}', which is not an evidence turn, but it carries "${evidenceRule}"`,
      )
    }
    return
  }
  if (!requestText.includes(DEEP_RESEARCH_EVIDENCE_TURN_IDENTITY)) return
  // A worker dispatched straight at a provider never reaches the turn service,
  // so it carries no injected rules and no evidence mode was chosen for the
  // prompt to contradict.
  if (!requestText.includes(MCP_TOOL_RULES_HEADING)) return
  const acquires = requestText.includes(EVIDENCE_TURN_ACQUIRE_RULE)
  const corrects = requestText.includes(EVIDENCE_TURN_PACKET_CORRECTION_RULE)
  if (acquires && corrects) {
    throw new Error(
      'Deep Research prompt contradiction: the evidence turn carries both the acquire rules and the bounded packet-correction rule.',
    )
  }
  if (!acquires && !corrects) {
    throw new Error(
      `Deep Research prompt contradiction: the evidence turn carries the injected ${MCP_TOOL_RULES_HEADING} without "${EVIDENCE_TURN_ACQUIRE_RULE}" or "${EVIDENCE_TURN_PACKET_CORRECTION_RULE}"`,
    )
  }
}

// Deterministic Receptionist decision for the Run UI smoke journey. The
// reply carries the sentinel only when the request text (system prompt with
// grounded file context, or history) contained it, so an ungrounded pipeline
// cannot produce a passing answer.
function echoSentinelDecision(requestText) {
  const sentinel = SENTINEL_PATTERN
    ? requestText.match(new RegExp(SENTINEL_PATTERN))?.[0]
    : undefined
  return JSON.stringify({
    message: sentinel
      ? `Grounded reply: the uploaded file states ${sentinel}.`
      : 'I do not have the uploaded file content.',
    selectionAction: 'clear',
    workflowId: null,
    launchIntent: 'none',
    deepResearchPlanAction: 'keep',
    deepResearchMissingInputs: [],
  })
}

/**
 * The Run-chat receptionist for the Deep Research journey.
 *
 * Deep Research intake is a real two-turn conversation: the first reply names
 * the workflow and asks for the unresolved fields, and only the user's answer
 * settles them. The answer is recognised by its own shape ("2. for me"), not
 * by a loose keyword, because the system prompt and the workflow catalogue
 * both contain words like "quality".
 */
function deepResearchReceptionistDecision(requestText) {
  const intakeAnswered = /2\s*\.\s*for me/i.test(requestText)
  if (!intakeAnswered) {
    return JSON.stringify({
      message: [
        'Deep Research fits this. Four quick questions before I plan it:',
        '',
        '1. Keep the scope to downtown Detroit only?',
        '2. Who is this report for?',
        '3. Rank on food quality, price, or both?',
        '4. Anything to exclude?',
      ].join('\n'),
      selectionAction: 'select',
      workflowId: 'deep-research-report',
      launchIntent: 'none',
      deepResearchPlanAction: 'keep',
      deepResearchMissingInputs: [
        'target audience',
        'research objective and output',
        'scope and comparison criteria',
        'jurisdiction or no geographic constraint',
        'exclusions or no exclusions',
      ],
    })
  }
  return JSON.stringify({
    message: [
      'Intake is complete: downtown Detroit only, for you, ranked on food',
      'quality, with nothing excluded. Research-plan generation is starting',
      'automatically. Planning will continue in the background, and progress',
      'will appear in this session.',
    ].join(' '),
    selectionAction: 'select',
    workflowId: 'deep-research-report',
    launchIntent: 'none',
    deepResearchPlanAction: 'keep',
    deepResearchMissingInputs: [],
  })
}

// One QualityVerdict, transported the way the active scenario says. The
// fenced form is a real provider shape: the object is complete and valid, but
// it arrives inside a Markdown code fence rather than as a bare response.
function deepResearchQualityVerdict(verdict) {
  const json = JSON.stringify(verdict)
  return DEEP_RESEARCH_FENCED_QUALITY_VERDICT
    ? `\`\`\`json\n${json}\n\`\`\`\n`
    : json
}

function deepResearchTextResponse(prompt) {
  if (/Reply with exactly NOOP\./i.test(prompt)) return 'NOOP'
  if (/You are the run setup assistant/i.test(prompt)) {
    return deepResearchReceptionistDecision(prompt)
  }
  if (/# Evidence Critic/i.test(prompt)) {
    const correctionWaveMatches = [
      ...prompt.matchAll(/"correctionWave"\s*:\s*([012])/gi),
    ]
    const correctionWave =
      DEEP_RESEARCH_CORRECTION_SCENARIO &&
      deepResearchCorrectionIssued
        ? 1
        : Number(correctionWaveMatches.at(-1)?.[1] ?? 0)
    if (DEEP_RESEARCH_CORRECTION_SCENARIO && !deepResearchCorrectionIssued) {
      deepResearchCorrectionIssued = true
      return deepResearchQualityVerdict({
        schemaVersion: 1,
        verdictId: 'fixture-correction-wave-0',
        correctionWave: 0,
        decision: 'REVISE',
        findings: [{
          code: 'required_authority_missing',
          severity: 'blocking',
          message:
            'The launch claim needs one targeted confirmation pass.',
          taskIds: ['T1'],
          sectionIds: ['launch-evidence'],
          claimIds: [],
          sourceIds: [],
        }],
        correctionRequests: [{
          schemaVersion: 1,
          id: 'confirm-launch-evidence',
          type: 'new_research',
          claimIds: [],
          taskIds: ['T1'],
          sectionIds: ['launch-evidence'],
          question:
            'Re-observe the approved source and confirm the launch evidence.',
          acceptanceCriteria: [
            'Return a replacement evidence packet from a fresh observation.',
          ],
          impactScope: 'local',
        }],
        correctionRoute: 'research',
        reviewedAt: '2026-07-17T12:00:00.000Z',
      })
    }
    return deepResearchQualityVerdict({
      schemaVersion: 1,
      verdictId: `fixture-approval-wave-${correctionWave}`,
      correctionWave,
      decision: 'APPROVE',
      findings: [],
      correctionRequests: [],
      reviewedAt: '2026-07-17T12:00:00.000Z',
    })
  }
  if (
    (
      /# Editor/i.test(prompt) ||
      /# Deep Research Publication Editor/i.test(prompt)
    ) &&
    /# Review Request/i.test(prompt)
  ) {
    return '<review_decision>APPROVE</review_decision>\n\nThe evidence-sealed report preserves its source and limitations.'
  }
  if (/# Research Section Writer/i.test(prompt)) {
    return deepResearchSection(prompt)
  }
  if (/# Research Synthesizer/i.test(prompt)) {
    return DEEP_RESEARCH_SECTION_JOURNEY
      ? deepResearchJourneyReport(prompt)
      : deepResearchReport(prompt)
  }
  if (
    /# Deep Research Publication Writer/i.test(prompt) ||
    /# Writer/i.test(prompt)
  ) {
    if (DEEP_RESEARCH_SECTION_JOURNEY) return deepResearchJourneyReport(prompt)
    // The editorial draft carries a citation the evidence graph never
    // validated, so publication must repair it before the report ships.
    return deepResearchReport(prompt, { plantUnvalidatedCitation: true })
  }
  if (/# Brief Builder/i.test(prompt)) {
    return [
      '# Evidence-Sealed Writing Brief',
      '',
      'Preserve the exact observed finding, source URL, and limitations in a concise decision report.',
      '',
      DEEP_RESEARCH_SECTION_JOURNEY
        ? deepResearchJourneyReport(prompt)
        : deepResearchReport(prompt),
    ].join('\n')
  }
  if (/# Research Planner/i.test(prompt)) {
    if (/Create the exact section\/task plan the user must approve/i.test(prompt)) {
      return JSON.stringify(deepResearchPlan(prompt))
    }
    return '# Approved Plan Ready\n\nThe embedded approved plan contains one bounded evidence task and is ready for execution.'
  }
  return 'NOOP'
}

function generateWordMarkdown() {
  return [
    '# Lorem Ipsum Document',
    '',
    '## Introduction',
    '',
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    '',
    '## Findings',
    '',
    '- The Markdown source is canonical.',
    '- Generate Word adds page numbers and a dynamic table of contents.',
    '',
    '## Delivery',
    '',
    '| Artifact | Format |',
    '| --- | --- |',
    '| Source | Markdown |',
    '| Final | Word |',
  ].join('\n')
}

function generateExcelMarkdown() {
  return [
    '# Lorem Ipsum Workbook',
    '',
    '## Metrics',
    '',
    'Fixture metrics for the deterministic Excel conversion.',
    '',
    '| Metric | Value | Share |',
    '| --- | ---: | ---: |',
    '| Leads | 120 | 60% |',
    '| Deals | $45,000 | 40% |',
    '',
    '## Delivery',
    '',
    '| Artifact | Format |',
    '| --- | --- |',
    '| Source | Markdown |',
    '| Final | Excel |',
  ].join('\n')
}

function deepResearchPlan(prompt) {
  const limits = prompt.match(/Use at most (\d+) concurrent researchers and (\d+) minutes\./i)
  if (DEEP_RESEARCH_SECTION_JOURNEY) {
    return deepResearchSectionJourneyPlan({
      maxResearcherAgents: Number(limits?.[1] ?? 2),
      maxDurationMinutes: Number(limits?.[2] ?? 20),
    })
  }
  const sourceUrl = firstResearchSourceUrl(prompt)
  if (!sourceUrl) throw new Error('Deep Research planning fixture source URL is missing')
  const maxResearcherAgents = Number(limits?.[1] ?? 2)
  const maxDurationMinutes = Number(limits?.[2] ?? 20)
  const question = `What official evidence supports the bounded launch decision? Fixture source URL: ${sourceUrl}`
  return {
    schemaVersion: 1,
    planId: 'fixture-deep-research-plan',
    requestId: 'fixture-deep-research-request',
    request: {
      schemaVersion: 1,
      requestId: 'fixture-deep-research-request',
      question,
      objective: 'Produce an evidence-backed bounded launch recommendation.',
      audience: 'Product leadership',
      includedScope: ['Directly observed official launch evidence'],
      excludedScope: ['Unverified commentary'],
      desiredSections: ['Launch Evidence'],
      jurisdictions: [],
      freshnessAsOf: '2026-07-17T12:00:00.000Z',
      authenticatedDomains: [],
      sourceRequirements: ['Use the directly observed primary fixture source.'],
      maxDurationMinutes,
      maxResearcherAgents,
      outputFormats: ['markdown', 'docx'],
    },
    sections: [{
      schemaVersion: 1,
      id: 'launch-evidence',
      title: 'Launch Evidence',
      objective: 'Establish the directly observed launch evidence.',
      taskIds: ['T1'],
    }],
    tasks: [{
      schemaVersion: 1,
      id: 'T1',
      sectionId: 'launch-evidence',
      title: 'Collect official launch evidence',
      question,
      purpose: 'evidence_acquisition',
      workerSpecId: 'launch-worker',
      dependsOn: [],
      correctionWave: 0,
    }],
    workerSpecs: [{
      schemaVersion: 1,
      id: 'launch-worker',
      laneId: 'launch-lane',
      sectionId: 'launch-evidence',
      baseAgent: 'web-researcher',
      displayRole: 'Product Evidence Analyst',
      domain: 'Product launch',
      lens: 'foundational',
      methodCardIds: ['general-research-v1'],
      specialistStance:
        'Approach this assignment as a launch evidence analyst. Keep vendor claims and directly observed facts distinct.',
      question,
      decisionUse: 'Decide whether the product is ready for a bounded launch.',
      workingDefinitions: [
        'Count evidence only when a directly observed source establishes it.',
      ],
      dependencyClaimIds: [],
      sourceRequirements: {
        preferredTypes: ['primary'],
        requiredAuthorityTypes: ['primary'],
        queryHints: [`Fixture source URL: ${sourceUrl}`],
      },
      coverageRequirements: [{
        schemaVersion: 2,
        id: 'official-launch-evidence',
        label: 'Directly observed official evidence supporting or limiting the bounded launch decision',
        kind: 'decision',
        validation: 'decision_support',
        required: true,
      }],
      prohibitedAssumptions: ['Search snippets are evidence.'],
      stopRule: {
        minimumPrimarySources: 1,
        minimumIndependentSources: 1,
        maximumSources: 3,
      },
      limits: { deadlineMs: maxDurationMinutes * 60_000 },
    }],
    maxDurationMinutes,
    maxResearcherAgents,
    expectedPeakWorkers: 1,
    authenticatedDomains: [],
    executionPolicy: {
      schemaVersion: 1,
      complexity: 'complex',
      complexityRationale:
        'The publication journey verifies evidence-bound section drafting and final citation validation.',
      searchBreadth: 'focused',
      maxCostUsd: 12,
      evidenceTargets: {
        minimumSupportedClaims: 1,
        minimumIndependentSourcesPerConsequentialClaim: 1,
        crossVerifyConsequentialClaims: true,
      },
      stopping: {
        minimumExpectedInformationGain: 40,
        maximumCorrectionWaves: 2,
      },
      synthesis: {
        mode: 'section_dossiers',
        maximumParallelSections: 2,
      },
    },
  }
}

/**
 * The two-section sushi plan the Run-chat journey approves.
 *
 * Deliberately `section_dossiers` with two sections: a single-section plan
 * collapses to one draft and never exercises parallel section drafting, the
 * synthesis budget, or a quality review bound to more than one section.
 */
function deepResearchSectionJourneyPlan(limits) {
  if (DEEP_RESEARCH_JOURNEY_SOURCE_URLS.length < DEEP_RESEARCH_JOURNEY_SECTIONS.length) {
    throw new Error('Deep Research journey fixture source URLs are missing')
  }
  const question =
    'Which downtown Detroit sushi restaurants are worth a solo visit on food quality?'
  return {
    schemaVersion: 1,
    planId: 'fixture-sushi-plan',
    requestId: 'fixture-sushi-request',
    request: {
      schemaVersion: 1,
      requestId: 'fixture-sushi-request',
      question,
      objective:
        'Recommend downtown Detroit sushi restaurants for one diner, ranked on food quality.',
      audience: 'The requesting diner',
      includedScope: ['Sushi restaurants in downtown Detroit'],
      excludedScope: ['Restaurants outside downtown Detroit'],
      desiredSections: DEEP_RESEARCH_JOURNEY_SECTIONS.map((section) => section.title),
      jurisdictions: ['Detroit, Michigan'],
      freshnessAsOf: '2026-08-31T12:00:00.000Z',
      authenticatedDomains: [],
      sourceRequirements: ['Use directly observed restaurant sources.'],
      maxDurationMinutes: limits.maxDurationMinutes,
      maxResearcherAgents: limits.maxResearcherAgents,
      outputFormats: ['markdown', 'docx'],
    },
    sections: DEEP_RESEARCH_JOURNEY_SECTIONS.map((section) => ({
      schemaVersion: 1,
      id: section.id,
      title: section.title,
      objective: section.objective,
      taskIds: [section.taskId],
    })),
    tasks: DEEP_RESEARCH_JOURNEY_SECTIONS.map((section) => ({
      schemaVersion: 1,
      id: section.taskId,
      sectionId: section.id,
      title: `Collect ${section.title.toLowerCase()} evidence`,
      question: `${question} Focus: ${section.objective}`,
      purpose: 'evidence_acquisition',
      workerSpecId: `worker-${section.id}`,
      dependsOn: [],
      correctionWave: 0,
    })),
    workerSpecs: DEEP_RESEARCH_JOURNEY_SECTIONS.map((section, index) => ({
      schemaVersion: 1,
      id: `worker-${section.id}`,
      laneId: `lane-${section.id}`,
      sectionId: section.id,
      baseAgent: 'web-researcher',
      displayRole: section.displayRole,
      domain: 'Downtown Detroit sushi restaurants',
      lens: 'foundational',
      methodCardIds: ['general-research-v1'],
      specialistStance:
        'Approach this assignment as a restaurant evidence analyst. Keep observed menu and room facts separate from opinion.',
      question: `${question} Focus: ${section.objective}`,
      decisionUse: 'Decide where the diner should book.',
      workingDefinitions: [
        'Count a restaurant only when a directly observed source establishes it is in downtown Detroit.',
      ],
      dependencyClaimIds: [],
      sourceRequirements: {
        preferredTypes: ['primary'],
        requiredAuthorityTypes: ['primary'],
        queryHints: [`Fixture source URL: ${DEEP_RESEARCH_JOURNEY_SOURCE_URLS[index]}`],
      },
      coverageRequirements: [{
        schemaVersion: 2,
        id: `observed-${section.id}`,
        label: `Directly observed evidence for ${section.title.toLowerCase()}`,
        kind: 'decision',
        validation: 'decision_support',
        required: true,
      }],
      prohibitedAssumptions: ['Search snippets are evidence.'],
      stopRule: {
        minimumPrimarySources: 1,
        minimumIndependentSources: 1,
        maximumSources: 3,
      },
      limits: { deadlineMs: limits.maxDurationMinutes * 60_000 },
    })),
    maxDurationMinutes: limits.maxDurationMinutes,
    maxResearcherAgents: limits.maxResearcherAgents,
    expectedPeakWorkers: DEEP_RESEARCH_JOURNEY_SECTIONS.length,
    authenticatedDomains: [],
    executionPolicy: {
      schemaVersion: 1,
      complexity: 'complex',
      complexityRationale:
        'Two report sections each need their own directly observed evidence before one coherence pass.',
      searchBreadth: 'focused',
      maxCostUsd: 12,
      evidenceTargets: {
        minimumSupportedClaims: 2,
        minimumIndependentSourcesPerConsequentialClaim: 1,
        crossVerifyConsequentialClaims: true,
      },
      stopping: {
        minimumExpectedInformationGain: 40,
        maximumCorrectionWaves: 2,
      },
      synthesis: {
        mode: 'section_dossiers',
        maximumParallelSections: 2,
      },
    },
  }
}

function deepResearchReport(prompt, options = {}) {
  const sourceUrl = firstResearchSourceUrl(prompt)
  if (!sourceUrl) throw new Error('Deep Research report fixture source URL is missing')
  // Deliberately free of numerals and caveat words so the planted citation
  // exercises URL repair without disturbing the audit's other invariants.
  const plantedLines = options.plantUnvalidatedCitation
    ? [
        `${DEEP_RESEARCH_UNVALIDATED_SENTENCE} ${DEEP_RESEARCH_UNVALIDATED_URL}.`,
        '',
      ]
    : []
  return [
    '# Deep Research Launch Report',
    '',
    '## Executive Summary',
    '',
    `The directly observed primary source supports the bounded launch decision ([source](${sourceUrl})).`,
    '',
    ...plantedLines,
    '## Launch Evidence',
    '',
    `The source states that the launch evidence is verified and ready for a bounded decision ([source](${sourceUrl})).`,
    '',
    '## Decision Implications',
    '',
    'Proceed with the launch decision while retaining the evidence boundary described below.',
    '',
    '## Contradictions and Limitations',
    '',
    'No contradiction was observed. The principal limitation is that this fixture validates the workflow handoffs with one directly observed primary source.',
    '',
    '## Unresolved Questions',
    '',
    'No unresolved question blocks the bounded decision.',
    '',
    '## Sources',
    '',
    `- [Primary launch evidence](${sourceUrl})`,
  ].join('\n')
}

const JOURNEY_REPORT_TITLE = '# Downtown Detroit Sushi: Where One Diner Should Book'
const JOURNEY_SOURCE_LINE = /^- \[Observed restaurant source \d+\]\(/

/**
 * The multi-section sushi report, written from the drafts and evidence the
 * runtime materialized into this request.
 *
 * Nothing is invented: every section body and every cited URL comes out of the
 * bundle, so a synthesis stage that received no drafts produces no report
 * rather than a plausible-looking one.
 */
function deepResearchJourneyReport(prompt) {
  // Keyed by section id: a request can carry the same bundle more than once
  // (system plus user message, or a replayed turn), and a report that repeats
  // every section is not the one this journey publishes.
  const drafts = new Map()
  for (const match of prompt.matchAll(
    /## Evidence-bound section draft: ([^\n(]+)\(([^)\n]+)\)\n([\s\S]*?)(?=\n## Evidence-bound section draft:|\n## Requested corrections|\n## Prior report under revision|\n## Additional instructions|\n## Your task|$)/g,
  )) {
    const sectionId = match[2].trim()
    const body = match[3].trim()
    if (body && !drafts.has(sectionId)) drafts.set(sectionId, body)
  }
  const sources = [
    ...new Set(
      [...prompt.matchAll(/"canonicalUrl"\s*:\s*"(https?:\/\/[^"\\]+)"/g)]
        .map((match) => match[1]),
    ),
  ]
  if (drafts.size > 0 && sources.length > 0) {
    const citation = sources.map((url) => `[source](${url})`).join('; ')
    return [
      JOURNEY_REPORT_TITLE,
      '',
      '## Executive Summary',
      '',
      `The directly observed restaurant sources support a food-quality ranking for a solo diner in downtown Detroit (${citation}).`,
      '',
      ...[...drafts.values()].flatMap((body) => [body, '']),
      '## Decision Implications',
      '',
      "Book the room whose observed menu matches the diner's preference; the observed evidence supports either as a first visit.",
      '',
      '## Contradictions and Limitations',
      '',
      'No contradiction was observed. The evidence is limited to the restaurant sources this run directly read.',
      '',
      '## Unresolved Questions',
      '',
      'No unresolved question blocks the booking decision.',
      '',
      '## Sources',
      '',
      ...sources.map((url, index) => `- [Observed restaurant source ${index + 1}](${url})`),
    ].join('\n')
  }
  // Editorial and publication stages receive the finished package rather than
  // the synthesis bundle. They must preserve it, not rewrite it from memory.
  const carried = carriedJourneyReport(prompt)
  if (carried) return carried
  throw new Error(
    'Deep Research journey synthesis received no section drafts or sources',
  )
}

/** The already-written report, cut out of a downstream stage's request. */
function carriedJourneyReport(prompt) {
  const start = prompt.lastIndexOf(JOURNEY_REPORT_TITLE)
  if (start < 0) return null
  const lines = prompt.slice(start).split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (JOURNEY_SOURCE_LINE.test(lines[index])) {
      return lines.slice(0, index + 1).join('\n').trim()
    }
  }
  return null
}

/**
 * The runtime materializes the section dossier into the request and expects one
 * `section_complete` JSON object back. The writer has no filesystem, so this
 * fixture reads only what the request carried — an earlier version opened the
 * dossier file, which let the fixture pass while every live writer refused.
 */
function deepResearchSection(prompt) {
  const dossier = materializedSectionDossier(prompt)
  const sources = Array.isArray(dossier?.sources) ? dossier.sources : []
  const claims = Array.isArray(dossier?.claims) ? dossier.claims : []
  const sourceUrls = sources
    .map((source) => source?.canonicalUrl)
    .filter((url) => typeof url === 'string')
  const statements = claims
    .map((claim) => claim?.statement)
    .filter((statement) => typeof statement === 'string')
  if (
    typeof dossier?.sectionId !== 'string' ||
    typeof dossier?.title !== 'string' ||
    statements.length === 0 ||
    sourceUrls.length === 0
  ) {
    throw new Error('Deep Research section fixture dossier is incomplete')
  }
  const citation = sourceUrls.map((url) => `[source](${url})`).join('; ')
  return JSON.stringify({
    schemaVersion: 1,
    status: 'section_complete',
    sectionId: dossier.sectionId,
    claimIds: claims
      .map((claim) => claim?.claimId)
      .filter((claimId) => typeof claimId === 'string'),
    sourceIds: sources
      .map((source) => source?.sourceId)
      .filter((sourceId) => typeof sourceId === 'string'),
    markdown: [
      `## ${dossier.title}`,
      '',
      ...statements.flatMap((statement) => [
        `${statement} (${citation}).`,
        '',
      ]),
      'The finding remains limited to the approved scope.',
    ].join('\n'),
  })
}

/** The dossier payload the runtime fenced into the section-writer request. */
function materializedSectionDossier(prompt) {
  const marker = prompt.indexOf('# Section Evidence Dossier')
  if (marker < 0) {
    throw new Error('Deep Research section fixture dossier was not materialized')
  }
  const fence = /```json\s*([\s\S]*?)```/.exec(prompt.slice(marker))
  if (!fence?.[1]) {
    throw new Error('Deep Research section fixture dossier payload is missing')
  }
  return JSON.parse(fence[1])
}

function firstResearchSourceUrl(prompt) {
  const fixtureUrl = prompt.match(/Fixture source URL:\s*(https?:\/\/[^\s"}]*[^\s"}.,;:])/i)?.[1]
  if (fixtureUrl) return fixtureUrl
  const canonicalUrl = prompt.match(/"canonicalUrl"\s*:\s*"(https?:\/\/[^"\\]+)"/i)?.[1]
  if (canonicalUrl) return canonicalUrl
  return prompt.match(/https?:\/\/[^\s<>()\]"'`]+/i)?.[0]
}

function deepResearchEvidencePacket(prompt, observation) {
  if (
    !observation?.ok ||
    typeof observation.url !== 'string' ||
    typeof observation.text !== 'string' ||
    !isRecord(observation.observationReceipt)
  ) {
    throw new Error('Deep Research source observation was not supplied to the researcher')
  }
  // The page states its own citable sentence after an `EVIDENCE:` marker when
  // the fixture site supplies one, so a multi-section journey gets a distinct
  // observed fact per section instead of the same sentence twice.
  const markedExcerpt = observation.text.match(/^EVIDENCE:\s*(.+)$/m)?.[1]?.trim()
  const excerpt = markedExcerpt ||
    'Launch evidence is verified and ready for a bounded decision.'
  if (!observation.text.includes(excerpt)) {
    throw new Error('Deep Research fixture evidence excerpt is missing')
  }
  const receipt = observation.observationReceipt
  const taskId = requiredPromptValue(prompt, /Set taskId exactly to "([^"]+)"\./)
  const assignmentId = requiredPromptValue(prompt, /Set assignmentId exactly to "([^"]+)"\./)
  const workerSpecHash = requiredPromptValue(prompt, /Set workerSpecHash exactly to "([a-f0-9]{64})"\./)
  const assignmentJson = prompt.match(/ASSIGNMENT_JSON\s+---BEGIN UNTRUSTED DATA---\s+(\{[^\n]+\})/i)?.[1]
  const assignment = assignmentJson ? JSON.parse(assignmentJson) : null
  if (!isRecord(assignment) || typeof assignment.sectionId !== 'string' || typeof assignment.question !== 'string') {
    throw new Error('Deep Research approved assignment is missing')
  }
  if (
    typeof receipt.receiptId !== 'string' ||
    typeof receipt.observedAt !== 'string' ||
    typeof receipt.contentSha256 !== 'string'
  ) {
    throw new Error('Deep Research observation receipt is incomplete')
  }
  // Identifiers are per lane. A run with more than one section would otherwise
  // publish two different claims under one id and the evidence graph would
  // silently merge them.
  const claimId = `claim-${taskId}`
  const sourceId = `source-${taskId}`
  const requirementId = Array.isArray(assignment.coverageRequirements) &&
    typeof assignment.coverageRequirements[0]?.id === 'string'
    ? assignment.coverageRequirements[0].id
    : 'official-launch-evidence'
  return {
    schemaVersion: 1,
    assignmentId,
    taskId,
    workerSpecHash,
    question: assignment.question,
    shortAnswer: `The directly observed primary source states: ${excerpt}`,
    findings: [{
      schemaVersion: 1,
      claimId,
      taskId,
      sectionId: assignment.sectionId,
      statement: excerpt,
      kind: 'fact',
      evidenceStandard: 'single',
      sourceIds: [sourceId],
      evidenceLinks: [{
        sourceId,
        observationReceiptId: receipt.receiptId,
        observedExcerpt: excerpt,
        locator: 'Main content',
        relationship: 'supports',
      }],
      confidence: 'high',
      status: 'supported',
      applicableScope: ['bounded launch decision'],
    }],
    sources: [{
      schemaVersion: 1,
      sourceId,
      assignmentId,
      canonicalUrl: observation.url,
      title: typeof observation.title === 'string' ? observation.title : 'Primary launch evidence',
      publisher: 'Pipeline fixture publisher',
      independenceKey: new URL(observation.url).hostname,
      sourceType: 'primary',
      accessMethod: 'managed-browser',
      observationReceiptId: receipt.receiptId,
      observedAt: receipt.observedAt,
      contentSha256: receipt.contentSha256,
      status: 'usable',
    }],
    coverage: [{
      schemaVersion: 2,
      requirementId,
      status: 'satisfied',
      claimIds: [claimId],
      sourceIds: [sourceId],
      scope: ['bounded launch decision'],
      note: 'The directly observed primary source supports the bounded decision.',
    }],
    contradictions: [],
    unresolvedQuestions: [],
    stopReason: 'decision_useful',
  }
}

function requiredPromptValue(prompt, pattern) {
  const value = prompt.match(pattern)?.[1]
  if (!value) throw new Error('Deep Research response contract is incomplete')
  return value
}

function parseBrowserToolOutput(content) {
  if (typeof content !== 'string') return null
  try {
    const parsed = JSON.parse(content)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeToolCalls(response, model, calls) {
  writeCompletion(response, model, {
    role: 'assistant',
    content: null,
    tool_calls: calls,
  }, 'tool_calls')
}

function writeCompletion(
  response,
  model,
  message,
  finishReason = 'stop',
) {
  const usage = {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  }
  if (STREAMED_RESPONSES.has(response)) {
    writeStreamedCompletion(response, model, message, finishReason, usage)
    return
  }
  writeJson(response, 200, {
    id: `fixture-completion-${Date.now()}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  })
}

/**
 * The same completion as SSE chunks: its content in three deltas, each tool
 * call in its own chunk, then the finish reason with usage, then `[DONE]`.
 */
function writeStreamedCompletion(response, model, message, finishReason, usage) {
  if (response.destroyed) return
  const id = `fixture-completion-${Date.now()}`
  const frame = (delta, finish = null, extra = {}) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`
  const content = typeof message.content === 'string' ? message.content : ''
  const third = Math.ceil(content.length / 3)
  const pieces = [
    content.slice(0, third),
    content.slice(third, third * 2),
    content.slice(third * 2),
  ].filter((piece) => piece.length > 0)
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.end([
    ...pieces.map((piece) => frame({ content: piece })),
    ...toolCalls.map((call, index) => frame({ tool_calls: [{ index, ...call }] })),
    frame({}, finishReason, { usage }),
    'data: [DONE]\n\n',
  ].join(''))
}

function toolCall(id, name, encodedArguments) {
  return {
    id,
    type: 'function',
    function: { name, arguments: encodedArguments },
  }
}

function markerArguments(marker) {
  return JSON.stringify({ marker })
}

function extractToolResultText(content) {
  if (typeof content !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  return findText(parsed)
}

function findText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = findText(entry)
      if (text) return text
    }
    return null
  }
  if (!isRecord(value)) return null
  if (typeof value.text === 'string') return value.text
  for (const entry of Object.values(value)) {
    const text = findText(entry)
    if (text) return text
  }
  return null
}

async function readJsonBody(request) {
  const chunks = []
  let totalBytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > 1_048_576) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(response, statusCode, payload) {
  if (response.destroyed) return
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(payload))
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function shutdown(exitCode) {
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }).catch(() => {
      exitCode = 1
    })
  }
  process.exit(exitCode)
}

process.once('SIGINT', () => void shutdown(0))
process.once('SIGTERM', () => void shutdown(0))

server.once('error', (error) => {
  process.stderr.write(`Provider fixture failed: ${String(error)}\n`)
  void shutdown(1)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') {
    void shutdown(1)
    return
  }
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    url: `http://127.0.0.1:${address.port}`,
    models: MODEL_IDS,
  })}\n`)
})
