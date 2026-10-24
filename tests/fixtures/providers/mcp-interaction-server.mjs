import { createServer } from 'node:http'

const MODEL_TO_TOOL = new Map([
  ['fixture/approval', 'approval-write'],
  ['fixture/elicitation-form', 'elicit-form'],
  ['fixture/elicitation-url', 'elicit-url'],
])

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    writeJson(response, 200, {
      object: 'list',
      data: [...MODEL_TO_TOOL.keys()].map((id) => ({ id, object: 'model' })),
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/v1/responses') {
    try {
      const body = await readJsonBody(request)
      if (typeof body?.model !== 'string' || !Array.isArray(body?.input)) {
        throw new Error('Model and input are required')
      }
      writeJson(response, 200, {
        id: `fixture-response-${Date.now()}`,
        object: 'response',
        model: body.model,
        output_text: 'provider-validation-ok',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'provider-validation-ok' }],
        }],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
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
    if (
      typeof body?.model !== 'string' ||
      !Array.isArray(body?.messages) ||
      !Array.isArray(body?.tools)
    ) {
      throw new Error('Model, messages, and tools are required')
    }
    const expectedToolSuffix = MODEL_TO_TOOL.get(body.model)
    if (!expectedToolSuffix) throw new Error('Unsupported fixture model')
    const tool = body.tools.find(
      (candidate) =>
        candidate?.type === 'function' &&
        typeof candidate?.function?.name === 'string' &&
        candidate.function.name.endsWith(`__${expectedToolSuffix}`),
    )
    if (!tool) throw new Error('Expected MCP interaction tool is unavailable')

    const toolMessages = body.messages.filter((message) => message?.role === 'tool')
    if (toolMessages.length === 0) {
      writeCompletion(response, body.model, {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call-${expectedToolSuffix}`,
            type: 'function',
            function: {
              name: tool.function.name,
              arguments: JSON.stringify({ marker: `${expectedToolSuffix}-marker` }),
            },
          },
        ],
      }, 'tool_calls')
      return
    }

    const resultText = extractToolResultText(toolMessages.at(-1)?.content)
    if (!resultText) throw new Error('MCP interaction result was not supplied')
    writeCompletion(response, body.model, {
      role: 'assistant',
      content: `provider-consumed:${resultText}`,
    })
  } catch (error) {
    writeJson(response, 400, {
      error: {
        message: error instanceof Error ? error.message : 'Invalid request',
      },
    })
  }
})

function writeCompletion(response, model, message, finishReason = 'stop') {
  writeJson(response, 200, {
    id: `fixture-interaction-${Date.now()}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  })
}

function extractToolResultText(content) {
  if (typeof content !== 'string') return null
  try {
    return findText(JSON.parse(content))
  } catch {
    return null
  }
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
  if (!value || typeof value !== 'object') return null
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
  process.stderr.write(`MCP interaction provider fixture failed: ${String(error)}\n`)
  void shutdown(1)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') {
    process.stderr.write('MCP interaction provider fixture did not bind TCP\n')
    void shutdown(1)
    return
  }
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    url: `http://127.0.0.1:${address.port}`,
    pid: process.pid,
    models: [...MODEL_TO_TOOL.keys()],
  })}\n`)
})
