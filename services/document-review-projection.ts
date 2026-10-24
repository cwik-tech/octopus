import type { SessionFile } from '../contracts/sessions.js'
import { documentReviewCoverageSchema, type DocumentReviewCoverage } from '../contracts/document-reference.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export async function projectDocumentReviews(input: { files: readonly SessionFile[]; cacheDirs: readonly string[] }): Promise<SessionFile[]> {
  const latest = new Map<string, { updated: number; coverage: DocumentReviewCoverage }>()
  for (const directory of [...new Set(input.cacheDirs)]) {
    let entries: string[]
    try { entries = await fs.readdir(directory) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    for (const name of entries.filter((name) => /^doc_[a-f0-9]{64}\.coverage\.json$/.test(name))) {
      const target = path.join(directory, name)
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1_024 * 1_024) continue
      let payload: unknown
      try { payload = JSON.parse(await fs.readFile(target, 'utf8')) }
      catch (error) { if (error instanceof SyntaxError) continue; throw error }
      const parsed = documentReviewCoverageSchema.safeParse(payload)
      if (!parsed.success || !parsed.data.uploadedAt) continue
      const key = `${parsed.data.name}\0${parsed.data.uploadedAt}`
      const previous = latest.get(key)
      if (!previous || previous.updated < stat.mtimeMs) latest.set(key, { updated: stat.mtimeMs, coverage: parsed.data })
    }
  }
  return input.files.map((file) => {
    const review = latest.get(`${file.name}\0${file.uploadedAt}`)?.coverage
    return { ...file, ...(review ? { documentReview: review } : {}) }
  })
}
