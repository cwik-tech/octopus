import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as z from 'zod/v4'
import type { FileParserLauncher } from '../../core/file-parser-launcher.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import { pdfPageIndexSchema, type DocumentSource } from '../../contracts/document-reference.js'
import { modelImageSchema } from '../../contracts/model-image.js'

const parseManifest = z.object({ files: z.array(z.object({ source: z.string(), type: z.string().optional(), status: z.string(), outputs: z.record(z.string(), z.string()) })) })

/** Parse captured original bytes in isolation; never mutate an admitted source or send it to a model. */
export async function parseDocumentCopy(input: { name: string; contents: Buffer; launcher: FileParserLauncher; signal?: AbortSignal }): Promise<Pick<DocumentSource, 'text' | 'pages' | 'image'>> {
  if (!isSafePathSegment(input.name)) throw new Error('Invalid admitted document name')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-document-'))
  try {
    input.signal?.throwIfAborted()
    const source = path.join(directory, input.name)
    const output = path.join(directory, 'parsed')
    await fs.writeFile(source, input.contents)
    await input.launcher.parseFile({ filePath: source, outputDir: output, localOnly: true }, { ...(input.signal ? { signal: input.signal } : {}) })
    const manifest = parseManifest.parse(JSON.parse(await fs.readFile(path.join(output, '_manifest.json'), 'utf8')))
    const parsed = manifest.files.find((file) => file.source === input.name && file.status === 'success')
    if (parsed?.type === 'image') {
      const thumbnail = parsed.outputs.thumbnail
      if (!thumbnail || !isSafePathSegment(thumbnail)) throw new Error('Captured image preview is unavailable')
      const image = modelImageSchema.parse({ mimeType: 'image/jpeg', data: (await fs.readFile(path.join(output, thumbnail))).toString('base64') })
      return { text: null, image }
    }
    const textName = parsed?.outputs.text
    if (!textName || !isSafePathSegment(textName)) throw new Error('Captured document could not be parsed')
    const text = await fs.readFile(path.join(output, textName), 'utf8')
    const indexName = parsed?.outputs.parse
    const index = indexName && isSafePathSegment(indexName) ? pdfPageIndexSchema.safeParse(JSON.parse(await fs.readFile(path.join(output, indexName), 'utf8'))) : undefined
    input.signal?.throwIfAborted()
    return { text, ...(index?.success ? { pages: index.data.pages } : {}) }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
