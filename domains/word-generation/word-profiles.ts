import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { WordGenerationProfile } from './generate-word-types.js'

interface ProfileFile {
  readonly schemaVersion: 1
  readonly profiles: Record<string, Omit<WordGenerationProfile, 'id'>>
}

let builtInProfiles: ReadonlyMap<string, WordGenerationProfile> | undefined

export function listWordProfiles(): readonly WordGenerationProfile[] {
  return [...loadBuiltInProfiles().values()]
}

export function loadWordProfile(
  profileId = 'business-report',
  profilePath?: string,
): WordGenerationProfile {
  if (profilePath) {
    const file = parseProfileFile(path.resolve(profilePath))
    const entry = file.profiles[profileId]
    if (!entry) {
      throw new Error(`Word profile '${profileId}' was not found in ${profilePath}.`)
    }
    return validateProfile(profileId, entry)
  }
  const profile = loadBuiltInProfiles().get(profileId)
  if (!profile) {
    throw new Error(
      `Unknown Word profile '${profileId}'. Available profiles: ${[
        ...loadBuiltInProfiles().keys(),
      ].join(', ')}.`,
    )
  }
  return profile
}

function loadBuiltInProfiles(): ReadonlyMap<string, WordGenerationProfile> {
  if (builtInProfiles) return builtInProfiles
  const file = parseProfileFile(resolveBuiltInProfilePath())
  builtInProfiles = new Map(
    Object.entries(file.profiles).map(([id, profile]) => [
      id,
      validateProfile(id, profile),
    ]),
  )
  return builtInProfiles
}

function resolveBuiltInProfilePath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(moduleDirectory, 'profiles.json'),
    path.resolve(
      moduleDirectory,
      '..',
      '..',
      '..',
      'domains',
      'word-generation',
      'profiles.json',
    ),
    path.resolve(process.cwd(), 'domains', 'word-generation', 'profiles.json'),
  ]
  const resolved = candidates.find((candidate) => fs.existsSync(candidate))
  if (!resolved) {
    throw new Error('Built-in Word profiles are unavailable.')
  }
  return resolved
}

function parseProfileFile(filePath: string): ProfileFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Cannot read Word profiles from ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !(parsed as { profiles?: unknown }).profiles ||
    typeof (parsed as { profiles?: unknown }).profiles !== 'object'
  ) {
    throw new Error(`Word profile file ${filePath} does not use schema version 1.`)
  }
  return parsed as ProfileFile
}

function validateProfile(
  id: string,
  value: Omit<WordGenerationProfile, 'id'>,
): WordGenerationProfile {
  const profile = { id, ...value } as WordGenerationProfile
  if (
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(id) ||
    !nonEmpty(profile.displayName) ||
    !nonEmpty(profile.description) ||
    !nonEmpty(profile.headerText) ||
    !positive(profile.page?.widthDxa) ||
    !positive(profile.page?.heightDxa) ||
    !positive(profile.page?.marginDxa) ||
    !positive(profile.page?.headerFooterDxa) ||
    !nonEmpty(profile.typography?.bodyFont) ||
    !nonEmpty(profile.typography?.headingFont) ||
    !nonEmpty(profile.typography?.codeFont) ||
    !positive(profile.typography?.bodySize) ||
    !positive(profile.typography?.titleSize) ||
    !Array.isArray(profile.typography?.headingSizes) ||
    profile.typography.headingSizes.length !== 6 ||
    profile.typography.headingSizes.some((size) => !positive(size)) ||
    !positive(profile.typography?.inlineCodeSize) ||
    !positive(profile.typography?.codeBlockSize) ||
    !positive(profile.typography?.tableSize) ||
    !positive(profile.typography?.footerSize) ||
    !positive(profile.typography?.lineSpacing) ||
    !nonNegative(profile.typography?.paragraphAfter) ||
    !nonNegativeArray(profile.layout?.headingBefore, 6) ||
    !nonNegativeArray(profile.layout?.headingAfter, 6) ||
    !validLayout(profile.layout) ||
    typeof profile.tableOfContents?.enabled !== 'boolean' ||
    !Number.isInteger(profile.tableOfContents?.depth) ||
    profile.tableOfContents.depth < 1 ||
    profile.tableOfContents.depth > 6 ||
    !nonEmpty(profile.tableOfContents?.heading) ||
    !positive(profile.image?.maxWidthPx) ||
    !positive(profile.image?.maxHeightPx) ||
    typeof profile.mermaid?.enabled !== 'boolean' ||
    !['default', 'neutral', 'dark', 'forest', 'base'].includes(profile.mermaid?.theme) ||
    !nonNegative(profile.mermaid?.paddingPx) ||
    !validColors(profile.colors)
  ) {
    throw new Error(`Word profile '${id}' is invalid.`)
  }
  if (!/^#[0-9A-F]{6}$/i.test(profile.mermaid.backgroundColor)) {
    throw new Error(`Word profile '${id}' contains an invalid Mermaid background color.`)
  }
  return deepFreeze(profile)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nonNegativeArray(
  value: unknown,
  length: number,
): value is readonly number[] {
  return Array.isArray(value) &&
    value.length === length &&
    value.every(nonNegative)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validLayout(
  layout: WordGenerationProfile['layout'] | undefined,
): boolean {
  if (!layout) return false
  const nonNegativeValues = [
    layout.titleAfter,
    layout.tocTitleBefore,
    layout.tocTitleAfter,
    layout.quoteIndentLeft,
    layout.quoteIndentRight,
    layout.quoteBefore,
    layout.quoteAfter,
    layout.quoteBorderSpace,
    layout.codeBefore,
    layout.codeAfter,
    layout.codeIndent,
    layout.listAfter,
    layout.listIndentPerLevel,
    layout.listHanging,
    layout.tableIndent,
    layout.tableCellMargin,
    layout.tableCellMarginVertical,
    layout.tableParagraphAfter,
    layout.dividerBefore,
    layout.dividerAfter,
    layout.imageBefore,
    layout.imageAfter,
  ]
  return nonNegativeValues.every(nonNegative) &&
    [
      layout.quoteBorderSize,
      layout.codeLineSpacing,
      layout.tableLineSpacing,
      layout.tableBorderSize,
      layout.codeBorderSize,
      layout.dividerSize,
    ].every(positive)
}

function validColors(
  colors: WordGenerationProfile['colors'] | undefined,
): boolean {
  if (!colors) return false
  return [
    colors.ink,
    colors.heading,
    colors.headingDark,
    colors.muted,
    colors.border,
    colors.tableHeader,
    colors.code,
    colors.link,
  ].every((color) => typeof color === 'string' && /^[0-9A-F]{6}$/i.test(color))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
