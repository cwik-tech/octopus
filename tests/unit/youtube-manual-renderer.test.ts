import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'

import { loadWordProfile } from '../../domains/word-generation/word-profiles.js'
import { publishYoutubeManual } from '../../domains/youtube/youtube-manual-service.js'
import type { YoutubeManualPlan } from '../../domains/youtube/youtube-manual-types.js'
import { YOUTUBE_FRAME_EXTRACTION_MAX_WIDTH_PX } from '../../domains/youtube/youtube-frame-extraction.js'

const plan: YoutubeManualPlan = {
  manualPlanSchemaVersion: 1,
  video: {
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Créer un flux de travail 日本語',
    channelName: 'Équipe Démo',
    publishedAt: '2026-08-01',
    durationSeconds: 90,
  },
  templateId: 'step-by-step',
  sourceLanguage: 'fr',
  outputLanguage: 'fr',
  analysis: {
    mode: 'gemini',
    model: 'gemini-3.6-flash',
    generatedAt: '2026-08-12T12:00:00.000Z',
    warnings: [],
  },
  prerequisites: ['Access to the workflow editor', 'Permission to create a workflow'],
  summary: 'Ce guide explique comment créer le flux.',
  chapters: [{ id: 'instructions', order: 1, title: 'Instructions', stepIds: ['open-editor'] }],
  steps: [{
    id: 'open-editor',
    order: 1,
    title: 'Ouvrir l’éditeur',
    explanation: 'Ouvrez l’éditeur et repérez les contrôles.',
    startSeconds: 10,
    endSeconds: 20,
    visualCues: [{
      timestampSeconds: 12,
      importance: 'required',
      reason: 'Les contrôles deviennent visibles.',
      caption: 'Contrôles de l’éditeur',
      altText: 'Fenêtre de l’éditeur avec le panneau des contrôles ouvert',
    }],
  }],
}

test('instruction-manual Word profile is present and internally well formed', () => {
  const profile = loadWordProfile('instruction-manual')
  assert.equal(profile.tableOfContents.enabled, true)
  assert.equal(profile.tableOfContents.depth, 3)
  assert.equal(profile.image.maxWidthPx, 640)
  assert.ok(profile.image.maxHeightPx > 0)
  assert.ok(profile.layout.imageBefore >= 0)
  assert.ok(profile.layout.imageAfter >= 0)
  assert.ok(YOUTUBE_FRAME_EXTRACTION_MAX_WIDTH_PX >= profile.image.maxWidthPx)
})

test('manual publication writes accessible Markdown and a self-contained DOCX', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-render-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.join(directory, 'frames'))
  const framePath = path.join(directory, 'frames', 'step-open-editor-000012000.png')
  await fs.writeFile(framePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ))

  const result = await publishYoutubeManual({
    bundleDirectory: directory,
    plan,
    frames: [{
      stepId: 'open-editor',
      requestedTimestampSeconds: 12,
      actualTimestampSeconds: 12,
      relativePath: 'frames/step-open-editor-000012000.png',
      caption: 'Contrôles de l’éditeur',
      altText: 'Fenêtre de l’éditeur avec le panneau des contrôles ouvert',
      selectionReason: 'required cue',
      sha256: 'hash',
    }],
  })

  const markdown = await fs.readFile(path.join(directory, 'manual.md'), 'utf8')
  assert.match(markdown, /^# Créer un flux de travail 日本語/m)
  assert.match(markdown, /Équipe Démo/)
  assert.match(markdown, /## Prerequisites\n\n- Access to the workflow editor\n- Permission to create a workflow/)
  assert.match(markdown, /\[00:12\]\(https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&t=12s\)/)
  assert.match(markdown, /!\[Fenêtre de l’éditeur avec le panneau des contrôles ouvert\]/)
  assert.equal(result.warnings.length, 0)
  assert.ok(result.docx)
  assert.deepEqual([...result.docx.subarray(0, 2)], [80, 75])
  assert.deepEqual(await fs.readFile(path.join(directory, 'manual.docx')), result.docx)
  const archive = await JSZip.loadAsync(result.docx)
  const documentXml = await archive.file('word/document.xml')!.async('text')
  const relationshipsXml = await archive.file('word/_rels/document.xml.rels')!.async('text')
  const embeddedImages = Object.keys(archive.files).filter((name) =>
    name.startsWith('word/media/') && !archive.files[name]?.dir)
  assert.equal(embeddedImages.length, 1)
  assert.match(documentXml, /w:pStyle w:val="Heading2"/)
  assert.match(documentXml, /w:pStyle w:val="Heading3"/)
  assert.match(documentXml, /descr="Fenêtre de l’éditeur avec le panneau des contrôles ouvert"/)
  assert.match(relationshipsXml, /relationships\/image/)
  assert.equal(Object.keys(archive.files).some((name) => /source-video/i.test(name)), false)
})

test('manual publication refuses to omit a required screenshot', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-required-image-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  await assert.rejects(publishYoutubeManual({
    bundleDirectory: directory,
    plan,
    frames: [],
  }), /required screenshot is missing/i)
})

test('quick-guide and dense-visual templates both publish self-contained DOCX files', async (context) => {
  for (const templateId of ['quick-guide', 'dense-visual'] as const) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `youtube-manual-${templateId}-`))
    context.after(() => fs.rm(directory, { recursive: true, force: true }))
    await fs.mkdir(path.join(directory, 'frames'))
    await fs.writeFile(path.join(directory, 'frames', 'frame.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ))
    const result = await publishYoutubeManual({
      bundleDirectory: directory,
      plan: { ...plan, templateId },
      frames: [{ stepId: 'open-editor', requestedTimestampSeconds: 12,
        actualTimestampSeconds: 12, relativePath: 'frames/frame.png', caption: 'Controls',
        altText: 'Application controls in the editor', selectionReason: 'required', sha256: 'hash' }],
    })
    assert.ok(result.docx)
    const archive = await JSZip.loadAsync(result.docx)
    assert.equal(Object.keys(archive.files).some((name) =>
      name.startsWith('word/media/') && !archive.files[name]?.dir), true)
  }
})
