/// <reference lib="dom" />

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'

import puppeteer from 'puppeteer-core'

import { resolveBrowserExecutablePath } from '../browser/browser-executable.js'

const require = createRequire(import.meta.url)
const MAX_DIAGRAM_SOURCE_BYTES = 250_000

export class MermaidRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MermaidRenderError'
  }
}

export async function renderMermaidPng(params: {
  readonly source: string
  readonly theme: 'default' | 'neutral' | 'dark' | 'forest' | 'base'
  readonly backgroundColor: string
  readonly paddingPx: number
  readonly executablePath?: string
  readonly signal?: AbortSignal
}): Promise<Buffer> {
  if (!params.source.trim()) {
    throw new MermaidRenderError('Mermaid diagram is empty.')
  }
  if (Buffer.byteLength(params.source, 'utf8') > MAX_DIAGRAM_SOURCE_BYTES) {
    throw new MermaidRenderError('Mermaid diagram exceeds the 250 KB limit.')
  }
  if (params.signal?.aborted) throw abortError()
  const executablePath = resolveBrowserExecutablePath(params.executablePath)
  if (!executablePath) {
    throw new MermaidRenderError(
      'Chrome or Chromium is required to render Mermaid diagrams locally.',
    )
  }
  const profilePath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pipeline-mermaid-'),
  )
  const mermaidScript = await fs.readFile(
    require.resolve('mermaid/dist/mermaid.min.js'),
    'utf8',
  )
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: profilePath,
      args: ['--disable-background-networking', '--disable-sync'],
    }).catch((error) => {
      throw new MermaidRenderError(
        `Chrome could not start for Mermaid rendering: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
    const page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      const protocol = new URL(request.url()).protocol
      if (protocol === 'data:' || protocol === 'about:' || protocol === 'blob:') {
        void request.continue()
      } else {
        void request.abort('blockedbyclient')
      }
    })
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 2 })
    await page.setContent(
      `<main id="diagram" aria-label="Mermaid diagram"></main>`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.addStyleTag({
      content: [
        'html,body{margin:0;padding:0;background:transparent;}',
        '#diagram{display:inline-block;padding:var(--diagram-padding);background:var(--diagram-bg);}',
        'svg{display:block;max-width:none!important;height:auto;}',
      ].join(''),
    })
    await page.evaluate(
      ({ backgroundColor, paddingPx }) => {
        document.documentElement.style.setProperty('--diagram-bg', backgroundColor)
        document.documentElement.style.setProperty('--diagram-padding', `${paddingPx}px`)
      },
      {
        backgroundColor: params.backgroundColor,
        paddingPx: params.paddingPx,
      },
    )
    await page.addScriptTag({ content: mermaidScript })
    const message = await page.evaluate(
      async ({ source, theme }) => {
        try {
          const runtime = (globalThis as typeof globalThis & {
            mermaid?: {
              initialize(config: Record<string, unknown>): void
              render(id: string, source: string): Promise<{ svg: string }>
            }
          }).mermaid
          if (!runtime) return 'Mermaid runtime did not load.'
          runtime.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme,
            htmlLabels: false,
            deterministicIds: true,
            deterministicIDSeed: 'pipeline-generate-word',
          })
          const result = await runtime.render('generate-word-diagram', source)
          const target = document.querySelector('#diagram')
          if (!target) return 'Mermaid output container is unavailable.'
          target.innerHTML = result.svg
          return null
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      { source: params.source, theme: params.theme },
    )
    if (message) throw new MermaidRenderError(`Mermaid syntax is invalid: ${message}`)
    if (params.signal?.aborted) throw abortError()
    const element = await page.$('#diagram')
    if (!element) throw new MermaidRenderError('Mermaid output was not created.')
    const box = await element.boundingBox()
    if (!box || box.width < 1 || box.height < 1) {
      throw new MermaidRenderError('Mermaid output has no visible content.')
    }
    if (box.width > 8_000 || box.height > 8_000) {
      throw new MermaidRenderError('Mermaid output exceeds the 8000 px rendering limit.')
    }
    return Buffer.from(await element.screenshot({
      type: 'png',
      omitBackground: true,
    }))
  } finally {
    await browser?.close().catch(() => undefined)
    await fs.rm(profilePath, { recursive: true, force: true }).catch(() => undefined)
  }
}

function abortError(): Error {
  return new DOMException('Generate Word was cancelled.', 'AbortError')
}
