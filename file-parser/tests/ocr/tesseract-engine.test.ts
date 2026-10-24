import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  OCR_LANGUAGE_DATA_DIR_ENV,
  OCR_TRAINED_DATA_FILE,
  OcrAssetUnavailableError,
  OcrEngineError,
  indexRecognitionParameters,
  recognizedPageFromResult,
  resolveOcrLanguageDirectory,
  tesseractWorkerOptions,
} from '../../ocr/tesseract-engine.js'
import { ocrIndexProfile } from '../../ocr/contract.js'
import { MIXED_OCR_FIXTURE } from '../mixed-ocr-expectations.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-assets-test-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('resolveOcrLanguageDirectory: the packaged English data is found in this installation', () => {
  const directory = resolveOcrLanguageDirectory({})

  assert.ok(
    fs.existsSync(path.join(directory, OCR_TRAINED_DATA_FILE)),
    'The bundled language data must be resolvable without a network request',
  )
})

test('resolveOcrLanguageDirectory: a missing asset is an installation error naming the asset', () => {
  withTempDir((dir) => {
    let failure: unknown
    try {
      resolveOcrLanguageDirectory({ [OCR_LANGUAGE_DATA_DIR_ENV]: dir })
    } catch (error) {
      failure = error
    }

    assert.ok(failure instanceof OcrAssetUnavailableError, 'A missing asset is an installation error')
    assert.ok(
      failure.message.includes(OCR_TRAINED_DATA_FILE),
      'The error must name the missing logical asset',
    )
    assert.ok(
      !failure.message.includes(dir),
      'The error must not expose an absolute path in product-facing text',
    )
  })
})

test('resolveOcrLanguageDirectory: a file that is not compressed language data is rejected', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, OCR_TRAINED_DATA_FILE), 'not gzip at all')

    assert.throws(
      () => resolveOcrLanguageDirectory({ [OCR_LANGUAGE_DATA_DIR_ENV]: dir }),
      OcrAssetUnavailableError,
    )
  })
})

test('tesseractWorkerOptions: recognition is pinned to this installation and writes no cache', () => {
  const options = tesseractWorkerOptions({})

  // Left unset, tesseract.js 7.0.0 downloads the language data from the jsdelivr CDN
  // (src/worker-script/index.js:130), so an offline claim would be false.
  assert.ok(path.isAbsolute(options.langPath))
  assert.ok(fs.existsSync(path.join(options.langPath, OCR_TRAINED_DATA_FILE)))
  // Anything but "none" writes eng.traineddata into the current working directory
  // (src/worker-script/index.js:181).
  assert.equal(options.cacheMethod, 'none')
  // The bundled file is gzip; the engine sniffs the magic bytes and decompresses it itself.
  assert.equal(options.gzip, true)
  // Without a handler, createWorker.js:217 throws from inside its own message handler, which is
  // an uncaught exception on the main thread rather than a rejected job.
  assert.equal(typeof options.errorHandler, 'function')
})

test('indexRecognitionParameters: the engine is configured from the versioned profile', () => {
  assert.deepEqual(indexRecognitionParameters(), {
    preserve_interword_spaces: ocrIndexProfile().preserveInterwordSpaces ? '1' : '0',
  })
})

test('recognizedPageFromResult: a result without text is not a page that was read', () => {
  assert.throws(() => recognizedPageFromResult({ data: { blocks: [] } }), OcrEngineError)
  assert.throws(() => recognizedPageFromResult(null), OcrEngineError)
  assert.throws(() => recognizedPageFromResult({ data: { text: 42 } }), OcrEngineError)
})

test('recognizedPageFromResult: word and line geometry crosses the worker boundary', () => {
  const page = recognizedPageFromResult({
    data: {
      text: 'Sales & Marketing 5170\n',
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  text: 'Sales & Marketing 5170',
                  bbox: { x0: 10, y0: 20, x1: 400, y1: 40 },
                  words: [
                    { text: 'Sales', bbox: { x0: 10, x1: 60 } },
                    { text: '5170', bbox: { x0: 300, x1: 350 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  })

  assert.equal(page.text, 'Sales & Marketing 5170\n')
  assert.equal(page.lines.length, 1)
  assert.deepEqual(page.lines[0]?.bbox, { x0: 10, y0: 20, x1: 400, y1: 40 })
  assert.deepEqual(page.lines[0]?.words, [
    { text: 'Sales', x0: 10, x1: 60 },
    { text: '5170', x0: 300, x1: 350 },
  ])
})

test('recognizedPageFromResult: malformed geometry is skipped, never fatal', () => {
  // Reconstruction is a pure function of the lines, and an empty list degrades to the flat
  // text — which is the behaviour every page had before geometry existed.
  const page = recognizedPageFromResult({
    data: {
      text: 'Approved operating plan',
      blocks: [
        { paragraphs: 'not an array' },
        {
          paragraphs: [
            {
              lines: [
                { text: '   ', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, words: [] },
                { text: 'no box at all' },
                { text: 'infinite box', bbox: { x0: 0, y0: 0, x1: Number.POSITIVE_INFINITY, y1: 1 } },
                {
                  text: 'kept',
                  bbox: { x0: 1, y0: 2, x1: 3, y1: 4 },
                  words: [{ text: 'kept', bbox: { x0: 1, x1: 3 } }, { text: 'dropped', bbox: {} }],
                },
              ],
            },
          ],
        },
      ],
    },
  })

  assert.equal(page.text, 'Approved operating plan')
  assert.equal(page.lines.length, 1)
  assert.equal(page.lines[0]?.text, 'kept')
  assert.deepEqual(page.lines[0]?.words, [{ text: 'kept', x0: 1, x1: 3 }])
})

test('createTesseractRecognizer: basic recognition completes with the network closed', async (t) => {
  t.diagnostic('Runs the real engine in a child process with fetch, http, https, dns and non-loopback sockets refused')
  const { spawn } = await import('node:child_process')
  // Relative to the package root, because `NODE_OPTIONS` splits on whitespace and an absolute
  // path here may contain spaces. `--require` resolves against the child's working directory.
  const packageRoot = path.resolve(import.meta.dirname, '..', '..')
  const support = './tests/ocr/no-network.test-support.cjs'
  const probe = './tests/ocr/offline-recognition.test-support.mts'

  const { stdout, stderr, code } = await new Promise<{
    stdout: string
    stderr: string
    code: number | null
  }>((resolve, reject) => {
    const child = spawn(
      'npx',
      ['tsx', '--require', support, probe, String(MIXED_OCR_FIXTURE.imageOnlyPage)],
      {
        cwd: packageRoot,
        env: { ...process.env, NODE_OPTIONS: `--require ${support}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let out = ''
    let err = ''
    // A blocked download does not always fail cleanly: the engine's worker can leave the job
    // unsettled, which is a hang rather than an error. The probe has to report that as a
    // failure, so it is bounded here.
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      err += '\nOffline recognition did not finish within 90s; it appears to be waiting on the network.'
    }, 90_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { out += chunk })
    child.stderr.on('data', (chunk: string) => { err += chunk })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (exitCode) => {
      clearTimeout(timeout)
      resolve({ stdout: out, stderr: err, code: exitCode })
    })
  })

  assert.ok(
    !stderr.includes('NETWORK ACCESS ATTEMPTED'),
    `Local OCR must reach nothing outside this installation:\n${stderr}`,
  )
  assert.equal(code, 0, `Offline recognition failed:\n${stderr}`)
  assert.ok(
    stdout.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028),
    'The recognizer must read the pictured page without a network request',
  )
})
