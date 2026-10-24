import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import test from 'node:test'

import {
  YOUTUBE_DOCX_IMAGE_MAX_WIDTH_PX,
  YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX,
} from '../../domains/youtube/youtube-image-policy.js'

test('one YouTube image policy bounds browser, FFmpeg, and Word image widths', async () => {
  const profiles = JSON.parse(await fs.readFile('domains/word-generation/profiles.json', 'utf8'))
  assert.equal(YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX, 1_600)
  assert.equal(profiles.profiles['instruction-manual'].image.maxWidthPx, YOUTUBE_DOCX_IMAGE_MAX_WIDTH_PX)
  assert.ok(YOUTUBE_DOCX_IMAGE_MAX_WIDTH_PX <= YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX)
})
