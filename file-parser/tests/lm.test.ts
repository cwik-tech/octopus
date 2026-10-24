import test from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { OpenAiLmEnricher } from '../lm/openai.js'
import { getLlmRuntimeConfigFromEnv } from '../lm/llm-model.js'
import { createLmEnricherFromEnv } from '../lm/index.js'
import { parsePdf } from '../parsers/pdf.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  return fn().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-parser-lm-test-'))
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

async function createMockResponsesServer(handler: (body: any, headers: http.IncomingHttpHeaders) => void): Promise<{
  server: http.Server
  baseUrl: string
}> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/responses') {
      res.statusCode = 404
      res.end('not found')
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      handler(body, req.headers)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        output_text: JSON.stringify({
          document_summary: 'Generic enriched summary for parser testing.',
          document_kind: 'slide-deck',
          key_entities: ['Entity Alpha'],
          key_metrics: [{ label: 'Metric One', value: '42', page: 1 }],
          page_summaries: [
            {
              page: 1,
              title: 'Page 1',
              summary: 'Generic visual page summary.',
              visual_elements: ['chart'],
              table_like: true,
              extracted_table_markdown: '| Metric | Value |\n| --- | --- |\n| Metric One | 42 |',
              extracted_key_values: [{ label: 'Metric One', value: '42' }],
              extracted_claims: ['Metric One exceeds the baseline.'],
            },
          ],
          recommended_pages: [1],
          confidence: 'medium',
        }),
      }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve mock server address.')
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

test('OpenAiLmEnricher sends the expected request contract', async () => {
  let seenBody: any = null
  let seenHeaders: http.IncomingHttpHeaders | null = null
  const { server, baseUrl } = await createMockResponsesServer((body, headers) => {
    seenBody = body
    seenHeaders = headers
  })

  try {
    const enricher = new OpenAiLmEnricher({
      apiKey: 'test-key',
      model: 'gpt-test',
      baseUrl,
    })

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-parser-lm-image-'))
    try {
      const imagePath = path.join(tempDir, 'page-001.jpg')
      fs.writeFileSync(imagePath, Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/', 'base64'))

      const result = await enricher.enrichPdf({
        source: 'deck.pdf',
        classification: 'visual',
        parseQuality: 'medium',
        qualityScore: 0.62,
        lmScope: 'flagged_pages',
        flaggedPages: [1],
        documentKind: 'slide-deck',
        pages: [
          {
            page: 1,
            title: 'Intro',
            parseQuality: 'medium',
            qualityScore: 0.62,
            text: 'Intro content',
            imagePath,
          },
        ],
      })

      assert.equal(result.provider, 'openai')
      assert.equal(result.model, 'gpt-test')
      assert.equal(result.response.document_kind, 'slide-deck')
      assert.ok(seenHeaders)
      assert.equal(seenHeaders?.authorization, 'Bearer test-key')
      assert.equal(seenBody.model, 'gpt-test')
      assert.equal(Array.isArray(seenBody.input), true)
      const userMessage = seenBody.input.find((item: any) => item.role === 'user')
      assert.ok(userMessage)
      assert.ok(userMessage.content.some((item: any) => item.type === 'input_image'))
      assert.ok(userMessage.content.some((item: any) => item.type === 'input_text'))
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
})

test('LLM runtime config loads OpenAI key from OPENAI_API_KEY', async () => {
  await withEnv({
    FILE_PARSER_LLM_ENABLED: '1',
    FILE_PARSER_LLM_PROVIDER: 'openai',
    FILE_PARSER_LLM_MODEL: 'gpt-test',
    FILE_PARSER_OPENAI_API_KEY: undefined,
    OPENAI_API_KEY: 'live-key-from-openai-env',
  }, async () => {
    const config = getLlmRuntimeConfigFromEnv()
    assert.equal(config.enabled, true)
    assert.equal(config.provider, 'openai')
    assert.equal(config.model, 'gpt-test')
    assert.equal(config.openAiApiKey, 'live-key-from-openai-env')
  })
})

test('LLM runtime config prefers FILE_PARSER_OPENAI_API_KEY over OPENAI_API_KEY', async () => {
  await withEnv({
    FILE_PARSER_LLM_ENABLED: '1',
    FILE_PARSER_OPENAI_API_KEY: 'file-parser-key',
    OPENAI_API_KEY: 'generic-openai-key',
  }, async () => {
    const config = getLlmRuntimeConfigFromEnv()
    assert.equal(config.openAiApiKey, 'file-parser-key')
  })
})

test('local-only mode builds no enricher even when enrichment is switched on, keyed and given an endpoint', async () => {
  await withEnv({
    FILE_PARSER_LLM_ENABLED: '1',
    FILE_PARSER_LM_ENABLED: '1',
    FILE_PARSER_LLM_PROVIDER: 'openai',
    FILE_PARSER_OPENAI_API_KEY: 'test-key',
    FILE_PARSER_OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    FILE_PARSER_LOCAL_ONLY: '1',
  }, async () => {
    assert.equal(createLmEnricherFromEnv(), null)
  })
})

test('parsePdf applies LM enrichment when enabled and parsing is visual', async () => {
  const pdfPath = path.join(FIXTURES, 'visual-deck.pdf')
  if (!fs.existsSync(pdfPath)) return

  let seenRequest: any = null
  const { server, baseUrl } = await createMockResponsesServer((body) => {
    seenRequest = body
  })

  try {
    await withEnv({
      FILE_PARSER_LM_ENABLED: '1',
      FILE_PARSER_LLM_PROVIDER: 'openai',
      FILE_PARSER_OPENAI_API_KEY: 'test-key',
      FILE_PARSER_OPENAI_BASE_URL: baseUrl,
      FILE_PARSER_LLM_MODEL: 'gpt-test',
      FILE_PARSER_LLM_ENABLED: '1',
    }, async () => {
      await withTempDir(async (dir) => {
        const result = await parsePdf(pdfPath, dir)
        assert.equal(result.status, 'success')
        assert.equal(result.enrichmentApplied, true)
        assert.equal(result.enrichmentProvider, 'openai')
        assert.ok(result.outputs.enriched)
        assert.ok(result.outputs.enrichment)
        assert.ok(fs.existsSync(path.join(dir, result.outputs.enriched!)))
        assert.ok(fs.existsSync(path.join(dir, result.outputs.enrichment!)))

        const enriched = fs.readFileSync(path.join(dir, result.outputs.enriched!), 'utf-8')
        assert.ok(enriched.includes('Generic enriched summary for parser testing.'))
        assert.ok(enriched.includes('## Per-Page Enrichment'))
        assert.ok(enriched.includes('#### Extracted Table'))
        assert.ok(enriched.includes('| Metric | Value |'))
        assert.ok(enriched.includes('#### Extracted Key Values'))
        assert.ok(enriched.includes('Metric One: 42'))
        assert.ok(enriched.includes('#### Extracted Claims'))

        const parseJson = JSON.parse(fs.readFileSync(path.join(dir, result.outputs.parse), 'utf-8')) as Record<string, unknown>
        assert.equal(parseJson.enrichment_applied, true)
        assert.equal(parseJson.enrichment_provider, 'openai')
      })
    })

    assert.ok(seenRequest)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
})
