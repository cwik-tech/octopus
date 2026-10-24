import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const DEFAULT_MAXIMUM_OUTPUT_BYTES = 10 * 1_024 * 1_024
const MAXIMUM_SINGLE_OUTPUT_BYTES = 5 * 1_024 * 1_024
const READABLE_OUTPUT_EXTENSIONS = new Set([
  '.csv',
  '.html',
  '.json',
  '.md',
  '.txt',
])
const PREFERRED_SEMANTIC_OUTPUTS = ['text', 'structure'] as const
const PAGE_MAP_OUTPUT = 'pageMap'
const ENRICHMENT_OUTPUT = 'enriched'

function resolveReadableOutput(parsedDir: string, output: unknown): string | null {
  if (typeof output !== 'string') return null
  const target = path.resolve(parsedDir, output)
  if (!target.startsWith(`${parsedDir}${path.sep}`)) return null
  if (!READABLE_OUTPUT_EXTENSIONS.has(path.extname(target).toLowerCase())) return null
  return target
}

async function readBoundedOutput(
  target: string,
  maximumBytes: number,
): Promise<{ content: string; bytesRead: number } | null> {
  const stat = await fs.stat(target).catch(() => null)
  if (!stat?.isFile() || maximumBytes <= 0) return null
  const bytesToRead = Math.min(stat.size, MAXIMUM_SINGLE_OUTPUT_BYTES, maximumBytes)
  const handle = await fs.open(target, 'r')
  try {
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    const truncated = bytesRead < stat.size
    return {
      content: `${buffer.subarray(0, bytesRead).toString('utf8')}${truncated ? '\n\n[Content truncated to parser output budget.]' : ''}`,
      bytesRead,
    }
  } finally {
    await handle.close()
  }
}

export async function readFileParserOutputs(
  inputDir: string,
  maximumOutputBytes = DEFAULT_MAXIMUM_OUTPUT_BYTES,
): Promise<string> {
  const parsedDir = path.resolve(inputDir, 'parsed')
  const manifestPath = path.join(parsedDir, '_manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
    files?: Array<{ source?: unknown; status?: unknown; outputs?: unknown }>
  }
  const sections: string[] = []
  let totalBytes = 0
  for (const file of manifest.files ?? []) {
    if (
      file.status !== 'success' ||
      !file.outputs ||
      typeof file.outputs !== 'object'
    ) {
      continue
    }
    const outputs = file.outputs as Record<string, unknown>
    let semantic: { content: string; bytesRead: number } | null = null
    let semanticTarget: string | null = null
    for (const key of PREFERRED_SEMANTIC_OUTPUTS) {
      const target = resolveReadableOutput(parsedDir, outputs[key])
      if (!target) continue
      const remainingBytes = maximumOutputBytes - totalBytes
      semantic = await readBoundedOutput(target, remainingBytes)
      if (semantic) {
        semanticTarget = target
        break
      }
      if (remainingBytes <= 0) break
    }
    if (!semantic || !semanticTarget) continue

    totalBytes += semantic.bytesRead
    const fileSections = [semantic.content]
    const pageMapTarget = resolveReadableOutput(parsedDir, outputs[PAGE_MAP_OUTPUT])
    if (pageMapTarget) {
      const pageMap = await readBoundedOutput(
        pageMapTarget,
        maximumOutputBytes - totalBytes,
      )
      if (pageMap) {
        totalBytes += pageMap.bytesRead
        fileSections.push(pageMap.content)
      }
    }
    const enrichmentTarget = resolveReadableOutput(parsedDir, outputs[ENRICHMENT_OUTPUT])
    if (enrichmentTarget) {
      const enrichment = await readBoundedOutput(
        enrichmentTarget,
        maximumOutputBytes - totalBytes,
      )
      if (enrichment) {
        totalBytes += enrichment.bytesRead
        fileSections.push(`## Parser Enrichment\n\n${enrichment.content}`)
      }
    }
    sections.push(
      `# ${String(file.source ?? path.basename(semanticTarget))}\n\n${fileSections.join('\n\n')}`,
    )
  }
  return sections.join('\n\n')
}
