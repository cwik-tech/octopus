/**
 * The Tesseract boundary: dependency loading, local language-data resolution, worker setup,
 * validation of everything the worker returns, recognition, and worker shutdown.
 *
 * Nothing outside this module imports `tesseract.js`, and nothing inside it knows what a PDF is.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { ocrIndexProfile, type OcrLineBox, type OcrWordBox, type RecognizedPage, type TextRecognizer } from './contract.js'

const require = createRequire(import.meta.url)

/** The file the engine looks for inside the directory it is given. */
export const OCR_TRAINED_DATA_FILE = 'eng.traineddata.gz'

/**
 * The packaged asset, named as the engine's own package path.
 *
 * `4.0.0_best_int`, not `4.0.0`: the integerised model is 2.8 MB against 10 MB and is the only
 * one the LSTM-only engine needs, which is the engine the versioned profile selects.
 */
export const OCR_TRAINED_DATA_PACKAGE_PATH = `@tesseract.js-data/eng/4.0.0_best_int/${OCR_TRAINED_DATA_FILE}`

/** Overrides the bundled location, for an installation that keeps the data elsewhere. */
export const OCR_LANGUAGE_DATA_DIR_ENV = 'FILE_PARSER_OCR_DATA_DIR'

/** A required OCR asset is missing or unusable. An installation problem, not a document problem. */
export class OcrAssetUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OcrAssetUnavailableError'
  }
}

/** The recognition engine failed, or returned something this package will not treat as a page. */
export class OcrEngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OcrEngineError'
  }
}

/**
 * Is this file gzip at all?
 *
 * Checked here rather than left to the engine, because the engine does not fail cleanly. Given a
 * file that is not the language data, `tesseract.js` 7.0.0 rejects the job and then dereferences
 * an already-settled promise inside its own `worker.on("message")` handler, which is an uncaught
 * exception in an event callback. Two magic bytes keep that from ever being reached.
 *
 * It is not a claim that the data is valid, only that it is the kind of file it should be.
 */
function looksLikeGzip(filePath: string): boolean {
  let handle: number
  try {
    handle = openSync(filePath, 'r')
  } catch {
    return false
  }
  try {
    const header = Buffer.alloc(2)
    const read = readSync(handle, header, 0, 2, 0)
    return read === 2 && header[0] === 0x1f && header[1] === 0x8b
  } finally {
    closeSync(handle)
  }
}

function requireUsableData(directory: string, describeSource: string): string {
  const file = path.join(directory, OCR_TRAINED_DATA_FILE)
  if (!existsSync(file)) {
    throw new OcrAssetUnavailableError(
      `The OCR language data is missing from this installation: ${describeSource} has no ${OCR_TRAINED_DATA_FILE}.`,
    )
  }
  if (!looksLikeGzip(file)) {
    throw new OcrAssetUnavailableError(
      `The OCR language data in this installation is not readable as compressed language data: ${describeSource} holds an unusable ${OCR_TRAINED_DATA_FILE}.`,
    )
  }
  return directory
}

/**
 * The directory holding the bundled English language data.
 *
 * Fails closed with a named error rather than letting the engine fall back to its default, which
 * is a CDN: an installation missing this file should say so, not quietly start downloading.
 *
 * Product-facing text names the logical asset, never an absolute path on the user's machine.
 */
export function resolveOcrLanguageDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OCR_LANGUAGE_DATA_DIR_ENV]
  if (override !== undefined && override.length > 0) {
    return requireUsableData(override, `the directory named by ${OCR_LANGUAGE_DATA_DIR_ENV}`)
  }

  let bundled: string
  try {
    bundled = path.dirname(require.resolve(OCR_TRAINED_DATA_PACKAGE_PATH))
  } catch (error) {
    throw new OcrAssetUnavailableError(
      `The OCR language data is missing from this installation: ${OCR_TRAINED_DATA_PACKAGE_PATH}.`,
      { cause: error },
    )
  }
  return requireUsableData(bundled, OCR_TRAINED_DATA_PACKAGE_PATH)
}

export interface TesseractWorkerOptions {
  langPath: string
  cacheMethod: 'none'
  gzip: true
  errorHandler: (reason: unknown) => void
}

/**
 * The options that make Tesseract run entirely from this installation.
 *
 * Exported so a test can assert them without starting an engine. Every field closes one
 * documented trap in the installed `tesseract.js` 7.0.0:
 *
 * - **`langPath`** is a local directory. Left unset, `src/worker-script/index.js:130` downloads
 *   the language data from the jsdelivr CDN on the first page.
 * - **`cacheMethod: "none"`** stops the write at `src/worker-script/index.js:181`, which
 *   otherwise puts `eng.traineddata` in `cachePath || '.'` — the process's working directory.
 * - **`gzip: true`** matches the file that is bundled.
 * - **`errorHandler`** is required, not optional. Without one, `src/createWorker.js:217` does
 *   `throw Error(data)` from inside its own `worker.on("message")` handler whenever the worker
 *   rejects a job, which is an uncaught exception on the main thread. The job promise is
 *   rejected on the line above, so this handler only has to exist for that rejection to be
 *   reachable normally.
 */
export function tesseractWorkerOptions(
  env: NodeJS.ProcessEnv = process.env,
): TesseractWorkerOptions {
  return {
    langPath: resolveOcrLanguageDirectory(env),
    cacheMethod: 'none',
    gzip: true,
    errorHandler: () => undefined,
  }
}

/**
 * The engine's parameters for the contract's index profile.
 *
 * The default page segmentation is selected by the absence of an override — that is how the
 * engine's own default is chosen, and the versioned profile says the default is the reading
 * that keeps a table's rows whole.
 */
export function indexRecognitionParameters(): Record<string, string> {
  return {
    preserve_interword_spaces: ocrIndexProfile().preserveInterwordSpaces ? '1' : '0',
  }
}

/** Resolve the installed engine enum through the name carried by the OCR contract. */
export function indexEngineValue<T>(engines: Readonly<{ LSTM_ONLY: T }>): T {
  return engines[ocrIndexProfile().engine]
}

/**
 * A property of an external value, read without an assertion.
 *
 * `Reflect.get` returns `unknown`; an indexed read through `in` would need a cast, and a cast of
 * a third party's return value is a claim nobody checked.
 */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function lineFromRecognition(value: unknown): OcrLineBox | null {
  const text = property(value, 'text')
  if (typeof text !== 'string' || text.trim().length === 0) return null

  const bbox = property(value, 'bbox')
  const x0 = finiteNumber(property(bbox, 'x0'))
  const y0 = finiteNumber(property(bbox, 'y0'))
  const x1 = finiteNumber(property(bbox, 'x1'))
  const y1 = finiteNumber(property(bbox, 'y1'))
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null

  const words: OcrWordBox[] = []
  const rawWords = property(value, 'words')
  if (Array.isArray(rawWords)) {
    for (const rawWord of rawWords) {
      const wordText = property(rawWord, 'text')
      if (typeof wordText !== 'string' || wordText.trim().length === 0) continue
      const wordBox = property(rawWord, 'bbox')
      const wordX0 = finiteNumber(property(wordBox, 'x0'))
      const wordX1 = finiteNumber(property(wordBox, 'x1'))
      if (wordX0 === null || wordX1 === null) continue
      words.push({ text: wordText, x0: wordX0, x1: wordX1 })
    }
  }

  return { text, bbox: { x0, y0, x1, y1 }, words }
}

/**
 * A recognized page, reconstructed from the engine's result rather than trusted.
 *
 * The text half is strict: `worker.recognize` resolves to whatever the worker thread posted back
 * across a structured-clone boundary from a WebAssembly build, and reaching straight for
 * `result.data.text` would put `undefined` into a page that nothing had read. The geometry half
 * is defensive in the other direction — a block, paragraph, line or word that does not carry the
 * expected shape is skipped, never fatal, because reconstruction is a pure function of the lines
 * and an empty list degrades to the flat text.
 */
export function recognizedPageFromResult(value: unknown): RecognizedPage {
  const text = property(property(value, 'data'), 'text')
  if (typeof text !== 'string') {
    throw new OcrEngineError(
      'The recognition engine returned no text field; the page cannot be treated as read.',
    )
  }

  const lines: OcrLineBox[] = []
  const blocks = property(property(value, 'data'), 'blocks')
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const paragraphs = property(block, 'paragraphs')
      if (!Array.isArray(paragraphs)) continue
      for (const paragraph of paragraphs) {
        const paragraphLines = property(paragraph, 'lines')
        if (!Array.isArray(paragraphLines)) continue
        for (const rawLine of paragraphLines) {
          const line = lineFromRecognition(rawLine)
          if (line !== null) lines.push(line)
        }
      }
    }
  }

  return { text, lines }
}

export interface ConfigurableTesseractWorker {
  setParameters(parameters: Readonly<Record<string, string>>): Promise<unknown>
  terminate(): Promise<unknown>
}

/** Apply the profile before exposing a worker, and release the worker if setup fails. */
export async function configureTesseractWorker<T extends ConfigurableTesseractWorker>(
  worker: T,
  parameters: Readonly<Record<string, string>>,
): Promise<T> {
  try {
    await worker.setParameters(parameters)
    return worker
  } catch (configurationError) {
    try {
      await worker.terminate()
    } catch (terminationError) {
      throw new OcrEngineError(
        'The recognition engine rejected its parameters and could not be terminated.',
        { cause: new AggregateError([configurationError, terminationError]) },
      )
    }
    throw configurationError
  }
}

function asOcrEngineError(error: unknown, what: string): OcrEngineError {
  if (error instanceof OcrEngineError) return error
  if (error instanceof OcrAssetUnavailableError) return new OcrEngineError(error.message, { cause: error })
  const reason = error instanceof Error ? error.message : String(error)
  return new OcrEngineError(`The recognition engine ${what}: ${reason}`, { cause: error })
}

export interface RecognizerOptions {
  env?: NodeJS.ProcessEnv
}

/**
 * Tesseract, configured to reach nothing outside this installation.
 *
 * The language is named as a string with a local `langPath`, not passed as bytes: in the
 * installed `tesseract.js` 7.0.0, `src/worker-script/index.js` reads `_lang.code` when loading
 * the file but `_lang.data` when naming the language to initialise, so the byte form asks the
 * engine to open a data file named after the entire array.
 *
 * The engine runs in a `worker_threads.Worker`, not a child process, so it shares this process's
 * module resolution and filesystem.
 */
export async function createTesseractRecognizer(
  options: RecognizerOptions = {},
): Promise<TextRecognizer> {
  // Imported here, so a text-only PDF never loads the engine or its WebAssembly core.
  const { createWorker, OEM } = await import('tesseract.js')

  let worker: Awaited<ReturnType<typeof createWorker>>
  try {
    worker = await createWorker(
      'eng',
      indexEngineValue(OEM),
      tesseractWorkerOptions(options.env ?? process.env),
    )
    worker = await configureTesseractWorker(worker, indexRecognitionParameters())
  } catch (error) {
    throw asOcrEngineError(error, 'could not be started')
  }

  return {
    async recognize(image) {
      try {
        // `blocks: true` is what makes word geometry cross the worker boundary; without it the
        // engine returns text alone and reconstruction has nothing to cluster.
        return recognizedPageFromResult(
          await worker.recognize(Buffer.from(image), {}, { blocks: true, text: true }),
        )
      } catch (error) {
        throw asOcrEngineError(error, 'could not read a page')
      }
    },
    async close() {
      await worker.terminate()
    },
  }
}
