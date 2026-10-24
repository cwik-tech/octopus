import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import JSZip from 'jszip'

import { writeFileAtomic } from '../../core/file-mutation.js'
import { generateWordBuffer } from '../word-generation/generate-word.js'
import type { YoutubeSelectedFrame } from './youtube-frame-types.js'
import { renderYoutubeManualMarkdown } from './youtube-manual-renderer.js'
import { parseYoutubeManualPlan } from './youtube-manual-schema.js'
import type { YoutubeManualPlan } from './youtube-manual-types.js'
import { assertYoutubeImagePolicy, YOUTUBE_DOCX_IMAGE_MAX_WIDTH_PX } from './youtube-image-policy.js'

export async function publishYoutubeManual(input: {
  readonly bundleDirectory: string
  readonly plan: YoutubeManualPlan
  readonly frames: readonly YoutubeSelectedFrame[]
  readonly signal?: AbortSignal
}): Promise<{
  readonly markdown: string
  readonly docx?: Buffer
  readonly warnings: readonly string[]
}> {
  const plan = parseYoutubeManualPlan(input.plan)
  assertYoutubeImagePolicy(YOUTUBE_DOCX_IMAGE_MAX_WIDTH_PX)
  await ensureSafeBundleDirectory(input.bundleDirectory)
  validateFramePaths(input.bundleDirectory, input.frames)
  const markdown = renderYoutubeManualMarkdown(plan, input.frames)
  const formats = plan.documentRequest?.formats ?? ['markdown', 'docx']
  const generated = formats.includes('docx') ? await generateWordBuffer(markdown, {
    profile: 'instruction-manual',
    sourceDirectory: input.bundleDirectory,
    title: plan.video.title,
    tableOfContents: plan.templateId !== 'quick-guide',
    renderMermaid: false,
    ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })),
  }) : undefined
  if (generated && generated.warnings.length > 0) {
    throw new Error('The YouTube manual could not embed every required screenshot.')
  }
  if (formats.includes('markdown')) {
    const content = `${markdown.trim()}\n`
    await writeFileAtomic(path.join(input.bundleDirectory, 'manual.md'), content)
    if (plan.documentRequest) {
      await writeMarkdownBundle(input.bundleDirectory, input.frames, content, input.signal)
    }
  }
  if (generated) await writeFileAtomic(path.join(input.bundleDirectory, 'manual.docx'), generated.buffer)
  return { markdown, ...(generated ? { docx: generated.buffer } : {}), warnings: generated?.warnings ?? [] }
}

async function ensureSafeBundleDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('YouTube manual bundle must be a safe real directory.')
  }
}

function validateFramePaths(
  bundleDirectory: string,
  frames: readonly YoutubeSelectedFrame[],
): void {
  const root = path.resolve(bundleDirectory)
  for (const frame of frames) {
    if (path.isAbsolute(frame.relativePath) || frame.relativePath.includes('\0')) {
      throw new Error('YouTube screenshot path is invalid.')
    }
    const resolved = path.resolve(root, frame.relativePath)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('YouTube screenshot path is invalid.')
    }
  }
}

async function writeMarkdownBundle(directory: string, frames: readonly YoutubeSelectedFrame[], markdown: string, signal?: AbortSignal): Promise<void> {
  const archive = new JSZip()
  const date = new Date('1980-01-01T00:00:00.000Z')
  archive.file('manual.md', markdown, { date })
  const root = await fs.realpath(directory)
  for (const frame of frames) {
    signal?.throwIfAborted()
    const imagePath = path.join(directory, frame.relativePath)
    const resolved = await fs.realpath(imagePath)
    const stat = await fs.lstat(imagePath)
    if (!resolved.startsWith(`${root}${path.sep}`) || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('YouTube screenshot path is invalid.')
    }
    archive.file(frame.relativePath, await fs.readFile(imagePath), { date })
  }
  signal?.throwIfAborted()
  await writeFileAtomic(path.join(directory, 'manual.zip'), await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}
