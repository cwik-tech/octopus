import type { WebshareRuntimeConfig } from '../proxy/webshare-settings.js'

export const YOUTUBE_SETTINGS_SCHEMA_VERSION = 2 as const

export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY'
export const YOUTUBE_GEMINI_MODEL = 'gemini-3.6-flash'
const MINIMUM_VIDEO_ANALYSIS_MODEL_VERSION = [3, 6] as const
export const DEFAULT_GEMINI_DAILY_VIDEO_MINUTES_LIMIT = 120
export const DEFAULT_GEMINI_CONFIRMATION_THRESHOLD_MINUTES = 30
export const DEFAULT_DELETE_VIDEOS_AFTER_INFO_EXTRACTION = false
export const YOUTUBE_GEMINI_BUDGET_WINDOW = 'rolling_24_hours' as const

export const DEFAULT_WEBSHARE_PROXY_HOST = 'p.webshare.io'
export const DEFAULT_WEBSHARE_PROXY_PORT = 80
export const DEFAULT_WEBSHARE_COUNTRIES = ['us'] as const

export const WEBSHARE_API_KEY_ENV = 'WEBSHARE_API_KEY'
export const WEBSHARE_USERNAME_ENV = 'WEBSHARE_USERNAME'
export const WEBSHARE_PASSWORD_ENV = 'WEBSHARE_PASSWORD'
export const WEBSHARE_PROXY_HOST_ENV = 'WEBSHARE_PROXY_HOST'
export const WEBSHARE_PROXY_PORT_ENV = 'WEBSHARE_PROXY_PORT'
export const WEBSHARE_PROXY_COUNTRIES_ENV = 'WEBSHARE_PROXY_COUNTRIES'

export type YoutubeProxyCredentialMode = 'api-token' | 'username-password'
export type YoutubeSettingsSource = 'default' | 'persisted' | 'environment'
export type YoutubeProxyStatus = 'unverified' | 'connected' | 'error'
export type YoutubeGeminiStatus = 'unverified' | 'connected' | 'error'

export interface YoutubeSettingsValues {
  readonly proxyEnabled: boolean
  readonly credentialMode: YoutubeProxyCredentialMode
  readonly proxyHost: string
  readonly proxyPort: number
  readonly countries: readonly string[]
  readonly username: string
}

export interface YoutubeSettingsUpdate extends YoutubeSettingsValues {
  readonly apiToken?: string
  readonly password?: string
  readonly clearApiToken?: boolean
  readonly clearPassword?: boolean
  readonly geminiApiKey?: string
  readonly clearGeminiApiKey?: boolean
  readonly geminiModel?: string
  readonly geminiDailyVideoMinutesLimit?: number
  readonly geminiConfirmationThresholdMinutes?: number
  readonly deleteVideosAfterInfoExtraction?: boolean
}

export interface YoutubeSettingsSnapshot extends YoutubeSettingsValues {
  readonly settingsSchemaVersion: typeof YOUTUBE_SETTINGS_SCHEMA_VERSION
  readonly source: YoutubeSettingsSource
  readonly apiTokenConfigured: boolean
  readonly passwordConfigured: boolean
  readonly proxyStatus: YoutubeProxyStatus
  readonly lastCheckedAt?: string
  readonly error?: string
  readonly geminiApiKeyConfigured: boolean
  readonly geminiSource: YoutubeSettingsSource
  readonly geminiStatus: YoutubeGeminiStatus
  readonly geminiModel: string
  readonly geminiLastCheckedAt?: string
  readonly geminiError?: string
  readonly geminiDailyVideoMinutesLimit: number
  readonly geminiConfirmationThresholdMinutes: number
  readonly geminiBudgetWindow: typeof YOUTUBE_GEMINI_BUDGET_WINDOW
  readonly geminiPricingVerifiedAt?: string
  readonly deleteVideosAfterInfoExtraction: boolean
}

/**
 * Parent-process-only configuration. Never serialize this object.
 *
 * The shape is owned by `domains/proxy/`, which is where the transport that
 * consumes it lives now that web research shares it.
 */
export type YoutubeRuntimeProxyConfig = WebshareRuntimeConfig

/** Parent-process-only configuration. Never serialize this object. */
export interface YoutubeRuntimeGeminiConfig {
  readonly apiKey?: string
  readonly model: string
  readonly source: YoutubeSettingsSource
}

export interface YoutubeGeminiSettingsValues {
  readonly geminiModel: string
  readonly geminiDailyVideoMinutesLimit: number
  readonly geminiConfirmationThresholdMinutes: number
}

export function normalizeYoutubeSettingsValues(
  value: YoutubeSettingsValues,
): YoutubeSettingsValues {
  const proxyHost = normalizeProxyHost(value.proxyHost)
  if (!proxyHost) throw new Error('Webshare proxy host is required.')
  if (!Number.isSafeInteger(value.proxyPort) || value.proxyPort < 1 || value.proxyPort > 65_535) {
    throw new Error('Webshare proxy port must be between 1 and 65535.')
  }
  if (
    value.credentialMode !== 'api-token' &&
    value.credentialMode !== 'username-password'
  ) {
    throw new Error('Webshare credential mode is invalid.')
  }
  const username = value.username.trim()
  if (username.length > 256) throw new Error('Webshare username is too long.')
  return {
    proxyEnabled: value.proxyEnabled === true,
    credentialMode: value.credentialMode,
    proxyHost,
    proxyPort: value.proxyPort,
    countries: normalizeCountries(value.countries),
    username,
  }
}

export function defaultYoutubeSettingsValues(): YoutubeSettingsValues {
  return {
    proxyEnabled: false,
    credentialMode: 'username-password',
    proxyHost: DEFAULT_WEBSHARE_PROXY_HOST,
    proxyPort: DEFAULT_WEBSHARE_PROXY_PORT,
    countries: [...DEFAULT_WEBSHARE_COUNTRIES],
    username: '',
  }
}

export function defaultYoutubeGeminiSettingsValues(): YoutubeGeminiSettingsValues {
  return {
    geminiModel: YOUTUBE_GEMINI_MODEL,
    geminiDailyVideoMinutesLimit: DEFAULT_GEMINI_DAILY_VIDEO_MINUTES_LIMIT,
    geminiConfirmationThresholdMinutes: DEFAULT_GEMINI_CONFIRMATION_THRESHOLD_MINUTES,
  }
}

export function normalizeYoutubeGeminiSettingsValues(
  value: YoutubeGeminiSettingsValues,
): YoutubeGeminiSettingsValues {
  const model = value.geminiModel.trim()
  const dailyLimit = value.geminiDailyVideoMinutesLimit
  const confirmationThreshold = value.geminiConfirmationThresholdMinutes
  if (!isYoutubeGeminiVideoAnalysisModel(model)) {
    throw new Error('Gemini model is not compatible with YouTube video analysis.')
  }
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100_000) {
    throw new Error('Gemini rolling 24-hour video-minute limit must be between 1 and 100000.')
  }
  if (
    !Number.isSafeInteger(confirmationThreshold) ||
    confirmationThreshold < 1 ||
    confirmationThreshold > 100_000
  ) {
    throw new Error('Gemini confirmation threshold must be between 1 and 100000 minutes.')
  }
  return {
    geminiModel: model,
    geminiDailyVideoMinutesLimit: dailyLimit,
    geminiConfirmationThresholdMinutes: confirmationThreshold,
  }
}

export function isYoutubeGeminiVideoAnalysisModel(model: string): boolean {
  const match = /^gemini-(\d+)\.(\d+)-(?:flash|flash-lite|pro)$/.exec(model)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const [minimumMajor, minimumMinor] = MINIMUM_VIDEO_ANALYSIS_MODEL_VERSION
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)
}

export function normalizeCountries(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new Error('Webshare countries must be an array.')
  const countries = [...new Set(values.map((value: string) => value.trim().toLowerCase()).filter(Boolean))]
  if (countries.length > 20) throw new Error('At most 20 Webshare countries may be configured.')
  if (countries.some((country) => !/^[a-z]{2}$/.test(country))) {
    throw new Error('Webshare countries must use two-letter country codes.')
  }
  return countries.length > 0 ? countries : [...DEFAULT_WEBSHARE_COUNTRIES]
}

function normalizeProxyHost(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '')
  if (
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(normalized)
  ) {
    throw new Error('Webshare proxy host is invalid.')
  }
  return normalized
}
