import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureParsed, loadInputFiles } from '../../parsers/input-files.js'
import type { FileParserLauncher } from '../../core/file-parser-launcher.js'
import { parseFileNotExpected } from '../support/file-parser-launcher-doubles.js'

function withTmpDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-input-files-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('ensureParsed delegates binary freshness checks even when parsed Markdown exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-parsed-test-'))
  const calls: string[] = []
  const launcher: FileParserLauncher = {
    async parseDirectory(inputDir) {
      calls.push(inputDir)
    },
    parseFile: parseFileNotExpected,
  }
  try {
    fs.writeFileSync(path.join(dir, 'document.pdf'), 'binary')
    fs.mkdirSync(path.join(dir, 'parsed'))
    fs.writeFileSync(path.join(dir, 'parsed', 'document.pdf.md'), 'old output')

    await ensureParsed(dir, launcher)

    assert.deepEqual(calls, [dir])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureParsed skips text-only input directories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-parsed-test-'))
  let called = false
  const launcher: FileParserLauncher = {
    async parseDirectory() {
      called = true
    },
    parseFile: parseFileNotExpected,
  }
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'text')
    await ensureParsed(dir, launcher)
    assert.equal(called, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureParsed logs parser failures without failing runtime boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-parsed-test-'))
  const originalError = console.error
  const messages: string[] = []
  console.error = (...values: unknown[]) => {
    messages.push(values.map(String).join(' '))
  }
  try {
    fs.writeFileSync(path.join(dir, 'document.pdf'), 'binary')
    await ensureParsed(dir, {
      async parseDirectory() {
        throw new Error('parser unavailable')
      },
      parseFile: parseFileNotExpected,
    })
    assert.ok(messages.some((message) => message.includes('parser unavailable')))
  } finally {
    console.error = originalError
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('returns empty string when directory does not exist', () => {
  const result = loadInputFiles('/nonexistent/path/that/cannot/exist-xyz-123')
  assert.equal(result, '')
})

test('returns empty string when directory has no non-hidden files', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '.hidden'), 'ignored')
    const result = loadInputFiles(dir)
    assert.equal(result, '')
  })
})

test('returns empty string when directory is completely empty', () => {
  withTmpDir((dir) => {
    const result = loadInputFiles(dir)
    assert.equal(result, '')
  })
})

test('reads .md files from parsed/ when available', () => {
  withTmpDir((dir) => {
    // Create a binary file in root (should be ignored)
    fs.writeFileSync(path.join(dir, 'doc.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]))
    // Create parsed/ with .md files
    const parsedDir = path.join(dir, 'parsed')
    fs.mkdirSync(parsedDir)
    fs.writeFileSync(path.join(parsedDir, 'doc.md'), 'Extracted text from PDF')

    const result = loadInputFiles(dir)
    assert.match(result, /## doc\.md/)
    assert.match(result, /Extracted text from PDF/)
  })
})

test('prefers canonical parsed markdown over diagnostic structure', () => {
  withTmpDir((dir) => {
    const parsedDir = path.join(dir, 'parsed')
    fs.mkdirSync(parsedDir)
    fs.writeFileSync(path.join(parsedDir, 'deck.pdf.md'), 'Canonical extracted text')
    fs.writeFileSync(path.join(parsedDir, 'deck.pdf.structure.md'), 'Diagnostic structure')

    const result = loadInputFiles(dir)
    assert.match(result, /deck\.pdf\.md/)
    assert.match(result, /Canonical extracted text/)
    assert.doesNotMatch(result, /Diagnostic structure/)
  })
})

test('combines canonical parsed markdown with additive enrichment', () => {
  withTmpDir((dir) => {
    const parsedDir = path.join(dir, 'parsed')
    fs.mkdirSync(parsedDir)
    fs.writeFileSync(path.join(parsedDir, 'deck.pdf.md'), 'Canonical extracted text')
    fs.writeFileSync(path.join(parsedDir, 'deck.pdf.structure.md'), 'Diagnostic structure')
    fs.writeFileSync(path.join(parsedDir, 'deck.pdf.pages.md'), 'Page 8 locator')
    fs.writeFileSync(path.join(parsedDir, 'deck.pdf.enriched.md'), 'Enriched extracted text')

    const result = loadInputFiles(dir)
    assert.match(result, /deck\.pdf\.md/)
    assert.match(result, /Canonical extracted text/)
    assert.match(result, /deck\.pdf\.enriched\.md/)
    assert.match(result, /Enriched extracted text/)
    assert.match(result, /deck\.pdf\.pages\.md/)
    assert.match(result, /Page 8 locator/)
    assert.ok(result.indexOf('Canonical extracted text') < result.indexOf('Page 8 locator'))
    assert.ok(result.indexOf('Page 8 locator') < result.indexOf('Enriched extracted text'))
    assert.doesNotMatch(result, /Diagnostic structure/)
  })
})

test('joins multiple parsed/ .md files with separator', () => {
  withTmpDir((dir) => {
    const parsedDir = path.join(dir, 'parsed')
    fs.mkdirSync(parsedDir)
    fs.writeFileSync(path.join(parsedDir, 'a.md'), 'Content A')
    fs.writeFileSync(path.join(parsedDir, 'b.md'), 'Content B')

    const result = loadInputFiles(dir)
    assert.match(result, /## a\.md/)
    assert.match(result, /Content A/)
    assert.match(result, /## b\.md/)
    assert.match(result, /Content B/)
    assert.match(result, /\n\n---\n\n/)
  })
})

test('falls back to text-safe extensions when no parsed/ directory', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'Plain text notes')
    fs.writeFileSync(path.join(dir, 'data.json'), '{"key":"value"}')

    const result = loadInputFiles(dir)
    assert.match(result, /## notes\.txt/)
    assert.match(result, /Plain text notes/)
    assert.match(result, /## data\.json/)
    assert.match(result, /\{"key":"value"\}/)
  })
})

test('fallback does not include binary files', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'image.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
    fs.writeFileSync(path.join(dir, 'doc.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]))
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'Some text')

    const result = loadInputFiles(dir)
    assert.doesNotMatch(result, /image\.jpg/)
    assert.doesNotMatch(result, /doc\.pdf/)
    assert.match(result, /## notes\.txt/)
  })
})

test('returns empty string when root dir has only binary files and no parsed/', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    fs.writeFileSync(path.join(dir, 'doc.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    const result = loadInputFiles(dir)
    assert.equal(result, '')
  })
})

test('parsed/ directory with no .md files falls through to root text files', () => {
  withTmpDir((dir) => {
    const parsedDir = path.join(dir, 'parsed')
    fs.mkdirSync(parsedDir)
    // parsed/ exists but has no .md files (e.g., only a .txt)
    fs.writeFileSync(path.join(parsedDir, 'output.txt'), 'txt in parsed')
    // Root has a .md file
    fs.writeFileSync(path.join(dir, 'readme.md'), 'Root readme')

    const result = loadInputFiles(dir)
    assert.match(result, /## readme\.md/)
    assert.match(result, /Root readme/)
  })
})

test('skips hidden files in parsed/ directory', () => {
  withTmpDir((dir) => {
    const parsedDir = path.join(dir, 'parsed')
    fs.mkdirSync(parsedDir)
    fs.writeFileSync(path.join(parsedDir, '.hidden.md'), 'Hidden content')
    fs.writeFileSync(path.join(parsedDir, 'visible.md'), 'Visible content')

    const result = loadInputFiles(dir)
    assert.doesNotMatch(result, /\.hidden\.md/)
    assert.match(result, /## visible\.md/)
  })
})

test('handles case-insensitive extensions in fallback (.MD, .TXT)', () => {
  withTmpDir((dir) => {
    // Write a file with uppercase extension (simulate cross-platform file)
    const filePath = path.join(dir, 'README.MD')
    fs.writeFileSync(filePath, 'Uppercase extension content')

    const result = loadInputFiles(dir)
    assert.match(result, /README\.MD/)
    assert.match(result, /Uppercase extension content/)
  })
})
