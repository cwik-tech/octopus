import {
  generateWordBuffer,
} from '../domains/word-generation/generate-word.js'
import type {
  GenerateWordOptions,
} from '../domains/word-generation/generate-word-types.js'

export interface MarkdownToDocxOptions
  extends Omit<GenerateWordOptions, 'profile'> {
  readonly profile?: string
}

/**
 * Backward-compatible adapter for the original Markdown publication transform.
 * New code should use generateWordBuffer so profile metadata and warnings are
 * available to the caller.
 */
export async function markdownToDocxBuffer(
  markdown: string,
  options: MarkdownToDocxOptions = {},
): Promise<Buffer> {
  return (await generateWordBuffer(markdown, {
    profile: options.profile ?? 'research-report',
    ...options,
  })).buffer
}
