import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExcelGenerationProfile } from './generate-excel-types.js'

interface ProfileFile {
  readonly schemaVersion: 1
  readonly profiles: Record<string, Omit<ExcelGenerationProfile, 'id'>>
}

let builtInProfiles: ReadonlyMap<string, ExcelGenerationProfile> | undefined

export function listExcelProfiles(): readonly ExcelGenerationProfile[] {
  return [...loadBuiltInProfiles().values()]
}

export function loadExcelProfile(
  profileId = 'business-workbook',
  profilePath?: string,
): ExcelGenerationProfile {
  if (profilePath) {
    const file = parseProfileFile(path.resolve(profilePath))
    const entry = file.profiles[profileId]
    if (!entry) {
      throw new Error(`Excel profile '${profileId}' was not found in ${profilePath}.`)
    }
    return validateProfile(profileId, entry)
  }
  const profile = loadBuiltInProfiles().get(profileId)
  if (!profile) {
    throw new Error(
      `Unknown Excel profile '${profileId}'. Available profiles: ${[
        ...loadBuiltInProfiles().keys(),
      ].join(', ')}.`,
    )
  }
  return profile
}

function loadBuiltInProfiles(): ReadonlyMap<string, ExcelGenerationProfile> {
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
      'excel-generation',
      'profiles.json',
    ),
    path.resolve(process.cwd(), 'domains', 'excel-generation', 'profiles.json'),
  ]
  const resolved = candidates.find((candidate) => fs.existsSync(candidate))
  if (!resolved) {
    throw new Error('Built-in Excel profiles are unavailable.')
  }
  return resolved
}

function parseProfileFile(filePath: string): ProfileFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Cannot read Excel profiles from ${filePath}: ${
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
    throw new Error(`Excel profile file ${filePath} does not use schema version 1.`)
  }
  return parsed as ProfileFile
}

function validateProfile(
  id: string,
  value: Omit<ExcelGenerationProfile, 'id'>,
): ExcelGenerationProfile {
  const profile = { id, ...value } as ExcelGenerationProfile
  if (
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(id) ||
    !nonEmpty(profile.displayName) ||
    !nonEmpty(profile.description) ||
    !nonEmpty(profile.fonts?.body) ||
    !positive(profile.fonts?.bodySize) ||
    !positive(profile.fonts?.headerSize) ||
    !positive(profile.fonts?.titleSize) ||
    !positive(profile.fonts?.noteSize) ||
    !validColors(profile.colors) ||
    typeof profile.table?.zebraStripes !== 'boolean' ||
    typeof profile.table?.autoFilter !== 'boolean' ||
    typeof profile.table?.freezeHeaderRow !== 'boolean' ||
    !positive(profile.table?.minColumnWidth) ||
    !positive(profile.table?.maxColumnWidth) ||
    profile.table.maxColumnWidth < profile.table.minColumnWidth ||
    !nonNegative(profile.table?.columnPadding) ||
    !nonEmpty(profile.numberFormats?.integer) ||
    !nonEmpty(profile.numberFormats?.decimal) ||
    !nonEmpty(profile.numberFormats?.currency) ||
    !nonEmpty(profile.numberFormats?.percent) ||
    !nonEmpty(profile.numberFormats?.date) ||
    typeof profile.sheet?.includeTitleRow !== 'boolean'
  ) {
    throw new Error(`Excel profile '${id}' is invalid.`)
  }
  return deepFreeze(profile)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validColors(
  colors: ExcelGenerationProfile['colors'] | undefined,
): boolean {
  if (!colors) return false
  return [
    colors.ink,
    colors.title,
    colors.headerText,
    colors.headerFill,
    colors.zebraFill,
    colors.note,
    colors.border,
  ].every((color) => typeof color === 'string' && /^[0-9A-F]{6}$/i.test(color))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
