import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { FileParserLauncher } from '../../core/file-parser-launcher.js'
import { readFileParserOutputs } from '../../core/file-parser-output.js'

const MAXIMUM_DOCUMENT_BYTES = 10 * 1_024 * 1_024

export class NativeDocumentParser {
  constructor(private readonly launcher: FileParserLauncher) {}

  async parse(params: {
    readonly bytes: Uint8Array
    readonly fileName: string
    readonly signal?: AbortSignal
  }): Promise<string> {
    if (
      params.bytes.byteLength < 1 ||
      params.bytes.byteLength > MAXIMUM_DOCUMENT_BYTES
    ) {
      throw new Error('The source document is outside the supported size limit.')
    }
    const safeName = safeDocumentName(params.fileName)
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'pipeline-research-document-'),
    )
    try {
      const sourcePath = path.join(temporaryDirectory, safeName)
      await fs.writeFile(sourcePath, params.bytes, {
        flag: 'wx',
        mode: 0o600,
      })
      await this.launcher.parseDirectory(temporaryDirectory, {
        ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
      })
      const text = await readFileParserOutputs(temporaryDirectory)
      if (!text.trim()) {
        throw new Error('The native document parser produced no readable evidence.')
      }
      return text
    } finally {
      await fs.rm(temporaryDirectory, {
        recursive: true,
        force: true,
      }).catch(() => undefined)
    }
  }
}

function safeDocumentName(value: string): string {
  const baseName = path.basename(value).normalize('NFC')
  const safe = baseName.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 200)
  if (
    !safe ||
    safe === '.' ||
    safe === '..' ||
    !['.docx', '.pdf', '.pptx', '.xlsx'].includes(
      path.extname(safe).toLowerCase(),
    )
  ) {
    throw new Error('The source document filename is unsupported.')
  }
  return safe
}
