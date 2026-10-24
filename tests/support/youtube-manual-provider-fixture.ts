import type { YoutubeDocumentRequest } from '../../contracts/youtube-document-request.js'
import * as http from 'node:http'

import type { YoutubeAction, YoutubeToolOutput } from '../../domains/youtube/youtube-types.js'

const model = 'fixture/youtube-manual'

export interface YoutubeManualProviderFixture {
  readonly baseUrl: string
  readonly chatCompletionsUrl: string
  receptionistRequestCount(): number
  workerActions(): readonly YoutubeAction[]
  close(): Promise<void>
}

/**
 * Deterministic OpenAI-compatible controller for the two LLM decisions around
 * the live acceptance lane. YouTube, Gemini, media tools, publication, and all
 * application transports remain real.
 */
export async function startYoutubeManualProviderFixture(input: {
  readonly videoId: string
  readonly videoUrl: string
  readonly documentRequest: YoutubeDocumentRequest
  readonly beforePrepare?: () => Promise<string>
}): Promise<YoutubeManualProviderFixture> {
  let receptionistRequests = 0
  const actions: YoutubeAction[] = []
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      writeJson(response, 200, {
        object: 'list',
        data: [{ id: model, object: 'model' }],
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/responses') {
      const body = await readJsonBody(request)
      const prompt = (Array.isArray(body.input) ? body.input : []).flatMap((message: Record<string, unknown>) =>
        Array.isArray(message.content) ? message.content.map((part: Record<string, unknown>) => typeof part.text === 'string' ? part.text : '') : [],
      ).join('\n')
      const reportStart = prompt.lastIndexOf('# Manual Generation Report')
      const text = reportStart >= 0 ? prompt.slice(reportStart) : 'The worker outputs remain authoritative.'
      writeJson(response, 200, { id: 'fixture-response', object: 'response', status: 'completed', model: body.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } })
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      writeJson(response, 404, { error: { message: 'Not found' } })
      return
    }

    try {
      const body = await readJsonBody(request)
      const tools = Array.isArray(body.tools) ? body.tools : []
      const youtubeTool = tools.find((tool) =>
        tool?.type === 'function' && tool.function?.name === 'youtube_extract')
      if (youtubeTool) {
        await handleWorkerTurn(response, body, youtubeTool.function.name)
        return
      }
      const prompt = messagesText(body.messages)
      const isReceptionist = prompt.includes('run setup assistant') ||
        prompt.includes('Run Orchestrator contract:')
      if (isReceptionist) receptionistRequests += 1
      writeCompletion(response, body.model, {
        role: 'assistant',
        content: isReceptionist
          ? JSON.stringify({
              message: 'The YouTube manual workflow is ready. Use Begin workflow to start.',
              selectionAction: 'select',
              workflowId: 'youtube-manual-generation',
              launchIntent: 'none',
              deepResearchPlanAction: 'keep',
              deepResearchMissingInputs: [],
            })
          : 'Live YouTube manual',
      })
    } catch (error) {
      process.stderr.write(`[youtube-manual-fixture] ${error instanceof Error ? error.message : 'Invalid request'}\n`)
      writeJson(response, 400, {
        error: { message: error instanceof Error ? error.message : 'Invalid request' },
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('YouTube manual provider fixture address unavailable.')
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  return {
    baseUrl,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    receptionistRequestCount: () => receptionistRequests,
    workerActions: () => [...actions],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }

  async function handleWorkerTurn(
    response: http.ServerResponse,
    body: Record<string, any>,
    toolName: string,
  ): Promise<void> {
    const toolResults = (Array.isArray(body.messages) ? body.messages : [])
      .filter((message: Record<string, unknown>) => message.role === 'tool')
      .map((message: Record<string, unknown>) => parseYoutubeOutput(message.content))
    const previous = toolResults.at(-1)
    if (previous && !previous.ok && previous.action !== 'capture') {
      throw new Error(`YouTube action ${previous.action} failed during the live journey.`)
    }
    if (toolResults.length === 0) {
      return callTool(response, body.model, toolName, {
        action: 'capture',
        url: input.videoUrl,
        languages: ['en'],
        limit: 1,
      })
    }
    if (toolResults.length === 1 && previous?.action === 'capture') {
      const manualRunId = await input.beforePrepare?.()
      return callTool(response, body.model, toolName, {
        action: 'prepare_manual',
        documentRequest: input.documentRequest,
        ...(manualRunId ? { manualRunId } : {}),
        url: input.videoUrl,
        templateId: 'quick-guide',
        outputLanguage: 'en',
      })
    }
    if (toolResults.length === 2 && previous?.action === 'prepare_manual') {
      if (!previous.manualRunId || previous.confirmationRequired) {
        throw new Error('Gemini preparation did not return an immediately buildable manual run.')
      }
      return callTool(response, body.model, toolName, {
        action: 'build_manual',
        videoId: input.videoId,
        manualRunId: previous.manualRunId,
      })
    }
    if (toolResults.length === 3 && previous?.action === 'build_manual') {
      const capture = toolResults[0]!
      writeCompletion(response, body.model, {
        role: 'assistant',
        content: [
          '# Manual Generation Report',
          '',
          `## ${input.videoUrl}`,
          '',
          `Transcript: ${capture.ok ? (capture.videos?.[0]?.transcriptMarkdown ?? `output/transcripts/${input.videoId}.md`) : 'unavailable; document analyzed directly from the video with Gemini'}`,
          `Markdown: ${previous.manualMarkdownPath}`,
          ...(previous.manualDocxPath ? [`Word: ${previous.manualDocxPath}`] : []),
          ...(previous.manualZipPath ? [`Portable Markdown: ${previous.manualZipPath}`] : []),
        ].join('\n'),
      })
      return
    }
    throw new Error('YouTube manual provider received an unexpected tool sequence.')
  }

  function callTool(
    response: http.ServerResponse,
    responseModel: unknown,
    toolName: string,
    argumentsValue: Record<string, unknown> & { action: YoutubeAction },
  ): void {
    actions.push(argumentsValue.action)
    writeCompletion(response, responseModel, {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: `call-youtube-${actions.length}`,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify(argumentsValue) },
      }],
    }, 'tool_calls')
  }
}

function parseYoutubeOutput(value: unknown): YoutubeToolOutput {
  if (typeof value !== 'string') throw new Error('YouTube tool result was not textual.')
  const parsed = JSON.parse(value) as unknown
  const output = findYoutubeOutput(parsed)
  if (!output) throw new Error('YouTube tool result did not match its output contract.')
  return output
}

function findYoutubeOutput(value: unknown): YoutubeToolOutput | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (
    'action' in value && typeof value.action === 'string' &&
    'ok' in value && typeof value.ok === 'boolean'
  ) return value as YoutubeToolOutput
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (typeof child === 'string') {
      try {
        const nested = findYoutubeOutput(JSON.parse(child) as unknown)
        if (nested) return nested
      } catch {
        // Continue searching structured siblings.
      }
    } else {
      const nested = findYoutubeOutput(child)
      if (nested) return nested
    }
  }
  return undefined
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 2 * 1_024 * 1_024) throw new Error('Request body is too large.')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>
}

function messagesText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map((message) => typeof message?.content === 'string' ? message.content : '').join('\n')
}

function writeCompletion(
  response: http.ServerResponse,
  responseModel: unknown,
  message: Record<string, unknown>,
  finishReason = 'stop',
): void {
  writeJson(response, 200, {
    id: `fixture-youtube-${Date.now()}`,
    object: 'chat.completion',
    model: typeof responseModel === 'string' ? responseModel : model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  })
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(payload))
}
