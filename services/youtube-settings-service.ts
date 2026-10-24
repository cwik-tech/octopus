import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import { writeFileAtomic } from '../core/file-mutation.js'
import {
  DEFAULT_WEBSHARE_PROXY_HOST,
  DEFAULT_WEBSHARE_PROXY_PORT,
  DEFAULT_DELETE_VIDEOS_AFTER_INFO_EXTRACTION,
  WEBSHARE_API_KEY_ENV,
  WEBSHARE_PASSWORD_ENV,
  WEBSHARE_PROXY_COUNTRIES_ENV,
  WEBSHARE_PROXY_HOST_ENV,
  WEBSHARE_PROXY_PORT_ENV,
  WEBSHARE_USERNAME_ENV,
  GEMINI_API_KEY_ENV,
  YOUTUBE_GEMINI_BUDGET_WINDOW,
  YOUTUBE_GEMINI_MODEL,
  YOUTUBE_SETTINGS_SCHEMA_VERSION,
  defaultYoutubeGeminiSettingsValues,
  defaultYoutubeSettingsValues,
  isYoutubeGeminiVideoAnalysisModel,
  normalizeCountries,
  normalizeYoutubeGeminiSettingsValues,
  normalizeYoutubeSettingsValues,
  type YoutubeRuntimeProxyConfig,
  type YoutubeRuntimeGeminiConfig,
  type YoutubeGeminiSettingsValues,
  type YoutubeGeminiStatus,
  type YoutubeSettingsSnapshot,
  type YoutubeSettingsSource,
  type YoutubeSettingsUpdate,
  type YoutubeSettingsValues,
  type YoutubeProxyStatus,
} from '../domains/youtube/youtube-settings.js'
import { validateWebshareProxy } from '../domains/proxy/webshare-proxy.js'
import {
  listYoutubeGeminiModels,
  validateYoutubeGeminiModel,
  type YoutubeGeminiModelOption,
} from '../domains/youtube/youtube-gemini-validation.js'
import { GEMINI_PRICING_METADATA } from '../domains/youtube/youtube-gemini-cost.js'

interface PersistedYoutubeSettings extends YoutubeSettingsValues, YoutubeGeminiSettingsValues {
  readonly settingsSchemaVersion: typeof YOUTUBE_SETTINGS_SCHEMA_VERSION
  readonly encryptedApiToken?: string
  readonly encryptedPassword?: string
  readonly encryptedGeminiApiKey?: string
  readonly deleteVideosAfterInfoExtraction: boolean
}

export interface YoutubeSecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}

export interface YoutubeSettingsServiceOptions {
  readonly storagePath?: string
  readonly secretCodec?: YoutubeSecretCodec
  readonly environment?: NodeJS.ProcessEnv
  readonly now?: () => Date
  readonly validationTimeoutMs?: number
  readonly validateProxy?: (
    config: YoutubeRuntimeProxyConfig,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly validateGemini?: (
    config: YoutubeRuntimeGeminiConfig,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly listGeminiModels?: (
    config: YoutubeRuntimeGeminiConfig,
    signal?: AbortSignal,
  ) => Promise<readonly YoutubeGeminiModelOption[]>
}

export class YoutubeSettingsService {
  private persisted: PersistedYoutubeSettings | undefined
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private proxyStatus: YoutubeProxyStatus = 'unverified'
  private lastCheckedAt?: string
  private validationError?: string
  private geminiStatus: YoutubeGeminiStatus = 'unverified'
  private geminiLastCheckedAt?: string
  private geminiValidationError?: string
  private readonly now: () => Date

  constructor(private readonly options: YoutubeSettingsServiceOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  async snapshot(): Promise<YoutubeSettingsSnapshot> {
    await this.ensureLoaded()
    try {
      return this.snapshotFromRuntime(this.runtimeFromState())
    } catch (error) {
      const environment = this.options.environment ?? process.env
      if (!hasEnvironmentOverride(environment)) throw error
      const defaults = defaultYoutubeSettingsValues()
      return {
        settingsSchemaVersion: YOUTUBE_SETTINGS_SCHEMA_VERSION,
        ...defaults,
        credentialMode: environment[WEBSHARE_API_KEY_ENV]?.trim()
          ? 'api-token'
          : 'username-password',
        source: 'environment',
        apiTokenConfigured: Boolean(environment[WEBSHARE_API_KEY_ENV]?.trim()),
        passwordConfigured: Boolean(environment[WEBSHARE_PASSWORD_ENV]?.trim()),
        proxyStatus: 'error',
        error: error instanceof Error
          ? error.message
          : 'Webshare environment configuration is invalid.',
        ...this.geminiSnapshotFields(),
        deleteVideosAfterInfoExtraction: this.persisted?.deleteVideosAfterInfoExtraction
          ?? DEFAULT_DELETE_VIDEOS_AFTER_INFO_EXTRACTION,
      }
    }
  }

  async update(input: YoutubeSettingsUpdate): Promise<YoutubeSettingsSnapshot> {
    if (
      (this.options.environment ?? process.env)[GEMINI_API_KEY_ENV]?.trim() &&
      (input.geminiApiKey !== undefined || input.clearGeminiApiKey !== undefined ||
        input.geminiModel !== undefined ||
        input.geminiDailyVideoMinutesLimit !== undefined ||
        input.geminiConfirmationThresholdMinutes !== undefined)
    ) {
      throw new Error('Gemini settings are read-only while GEMINI_API_KEY is configured.')
    }
    const values = normalizeYoutubeSettingsValues(input)
    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      let encryptedApiToken = this.persisted?.encryptedApiToken
      let encryptedPassword = this.persisted?.encryptedPassword
      let encryptedGeminiApiKey = this.persisted?.encryptedGeminiApiKey
      if (input.clearApiToken) encryptedApiToken = undefined
      else if (input.apiToken !== undefined) {
        encryptedApiToken = input.apiToken.trim()
          ? this.encryptSecret(input.apiToken.trim())
          : encryptedApiToken
      }
      if (input.clearPassword) encryptedPassword = undefined
      else if (input.password !== undefined) {
        encryptedPassword = input.password.trim()
          ? this.encryptSecret(input.password.trim())
          : encryptedPassword
      }
      if (input.clearGeminiApiKey) encryptedGeminiApiKey = undefined
      else if (input.geminiApiKey !== undefined) {
        encryptedGeminiApiKey = input.geminiApiKey.trim()
          ? this.encryptSecret(input.geminiApiKey.trim())
          : encryptedGeminiApiKey
      }
      const geminiValues = normalizeYoutubeGeminiSettingsValues({
        geminiModel:
          input.geminiModel
          ?? this.persisted?.geminiModel
          ?? defaultYoutubeGeminiSettingsValues().geminiModel,
        geminiDailyVideoMinutesLimit:
          input.geminiDailyVideoMinutesLimit
          ?? this.persisted?.geminiDailyVideoMinutesLimit
          ?? defaultYoutubeGeminiSettingsValues().geminiDailyVideoMinutesLimit,
        geminiConfirmationThresholdMinutes:
          input.geminiConfirmationThresholdMinutes
          ?? this.persisted?.geminiConfirmationThresholdMinutes
          ?? defaultYoutubeGeminiSettingsValues().geminiConfirmationThresholdMinutes,
      })
      if (values.credentialMode === 'api-token') {
        if (values.proxyEnabled && !encryptedApiToken) {
          throw new Error('Webshare API token is required when the proxy is enabled.')
        }
      } else {
        if (values.proxyEnabled && (!values.username || !encryptedPassword)) {
          throw new Error('Webshare username and password are required when the proxy is enabled.')
        }
      }
      const persisted: PersistedYoutubeSettings = {
        settingsSchemaVersion: YOUTUBE_SETTINGS_SCHEMA_VERSION,
        ...values,
        ...geminiValues,
        deleteVideosAfterInfoExtraction: input.deleteVideosAfterInfoExtraction
          ?? this.persisted?.deleteVideosAfterInfoExtraction
          ?? DEFAULT_DELETE_VIDEOS_AFTER_INFO_EXTRACTION,
        ...(encryptedApiToken ? { encryptedApiToken } : {}),
        ...(encryptedPassword ? { encryptedPassword } : {}),
        ...(encryptedGeminiApiKey ? { encryptedGeminiApiKey } : {}),
      }
      await this.persist(persisted)
      this.persisted = persisted
      this.proxyStatus = 'unverified'
      delete this.validationError
      delete this.lastCheckedAt
      this.geminiStatus = 'unverified'
      delete this.geminiValidationError
      delete this.geminiLastCheckedAt
      return this.snapshot()
    })
  }

  async runtimeProxy(): Promise<YoutubeRuntimeProxyConfig> {
    await this.ensureLoaded()
    const runtime = this.runtimeFromState()
    return {
      ...runtime.values,
      ...(runtime.apiToken ? { apiToken: runtime.apiToken } : {}),
      ...(runtime.password ? { password: runtime.password } : {}),
    }
  }

  async runtimeGemini(): Promise<YoutubeRuntimeGeminiConfig> {
    await this.ensureLoaded()
    const environmentKey = (this.options.environment ?? process.env)[GEMINI_API_KEY_ENV]?.trim()
    if (environmentKey) {
      return {
        apiKey: environmentKey,
        model: this.persisted?.geminiModel ?? YOUTUBE_GEMINI_MODEL,
        source: 'environment',
      }
    }
    const persistedKey = this.decryptSecret(this.persisted?.encryptedGeminiApiKey)
    return {
      ...(persistedKey ? { apiKey: persistedKey } : {}),
      model: this.persisted?.geminiModel ?? YOUTUBE_GEMINI_MODEL,
      source: persistedKey ? 'persisted' : 'default',
    }
  }

  async validate(signal?: AbortSignal): Promise<YoutubeSettingsSnapshot> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      const deadline = createDeadline(
        signal,
        this.options.validationTimeoutMs ?? 30_000,
      )
      try {
        const runtime = this.runtimeFromState()
        await (this.options.validateProxy ?? validateWebshareProxy)(
          {
            ...runtime.values,
            ...(runtime.apiToken ? { apiToken: runtime.apiToken } : {}),
            ...(runtime.password ? { password: runtime.password } : {}),
          },
          deadline.signal,
        )
        this.proxyStatus = 'connected'
        delete this.validationError
      } catch {
        this.proxyStatus = 'error'
        this.validationError = 'Webshare proxy validation failed.'
      } finally {
        deadline.clear()
      }
      this.lastCheckedAt = this.now().toISOString()
      return this.snapshot()
    })
  }

  async validateGemini(signal?: AbortSignal): Promise<YoutubeSettingsSnapshot> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      const deadline = createDeadline(
        signal,
        this.options.validationTimeoutMs ?? 30_000,
      )
      try {
        const runtime = await this.runtimeGemini()
        await (this.options.validateGemini ?? validateYoutubeGeminiModel)(runtime, deadline.signal)
        this.geminiStatus = 'connected'
        delete this.geminiValidationError
      } catch {
        this.geminiStatus = 'error'
        this.geminiValidationError = 'Gemini API key validation failed.'
      } finally {
        deadline.clear()
      }
      this.geminiLastCheckedAt = this.now().toISOString()
      return this.snapshot()
    })
  }

  async validateGeminiCandidate(
    input: { readonly apiKey: string; readonly model: string },
    signal?: AbortSignal,
  ): Promise<{ readonly valid: true }> {
    const defaults = defaultYoutubeGeminiSettingsValues()
    const model = normalizeYoutubeGeminiSettingsValues({
      ...defaults,
      geminiModel: input.model,
    }).geminiModel
    const deadline = createDeadline(signal, this.options.validationTimeoutMs ?? 30_000)
    try {
      await (this.options.validateGemini ?? validateYoutubeGeminiModel)({
        apiKey: input.apiKey.trim(),
        model,
        source: 'default',
      }, deadline.signal)
      return { valid: true }
    } finally {
      deadline.clear()
    }
  }

  async listGeminiModels(signal?: AbortSignal): Promise<readonly YoutubeGeminiModelOption[]> {
    await this.ensureLoaded()
    const deadline = createDeadline(signal, this.options.validationTimeoutMs ?? 30_000)
    try {
      const runtime = await this.runtimeGemini()
      return await (this.options.listGeminiModels ?? listYoutubeGeminiModels)(
        runtime,
        deadline.signal,
      )
    } finally {
      deadline.clear()
    }
  }

  private snapshotFromRuntime(runtime: {
    readonly values: YoutubeSettingsValues
    readonly source: YoutubeSettingsSource
    readonly apiToken?: string
    readonly password?: string
  }): YoutubeSettingsSnapshot {
    return {
      settingsSchemaVersion: YOUTUBE_SETTINGS_SCHEMA_VERSION,
      proxyEnabled: runtime.values.proxyEnabled,
      credentialMode: runtime.values.credentialMode,
      proxyHost: runtime.values.proxyHost,
      proxyPort: runtime.values.proxyPort,
      countries: [...runtime.values.countries],
      username: runtime.values.username,
      source: runtime.source,
      apiTokenConfigured: Boolean(runtime.apiToken),
      passwordConfigured: Boolean(runtime.password),
      proxyStatus: this.proxyStatus,
      ...(this.lastCheckedAt ? { lastCheckedAt: this.lastCheckedAt } : {}),
      ...(this.validationError ? { error: this.validationError } : {}),
      ...this.geminiSnapshotFields(),
      deleteVideosAfterInfoExtraction: this.persisted?.deleteVideosAfterInfoExtraction
        ?? DEFAULT_DELETE_VIDEOS_AFTER_INFO_EXTRACTION,
    }
  }

  private geminiSnapshotFields(): Pick<
    YoutubeSettingsSnapshot,
    | 'geminiApiKeyConfigured'
    | 'geminiSource'
    | 'geminiStatus'
    | 'geminiModel'
    | 'geminiLastCheckedAt'
    | 'geminiError'
    | 'geminiDailyVideoMinutesLimit'
    | 'geminiConfirmationThresholdMinutes'
    | 'geminiBudgetWindow'
    | 'geminiPricingVerifiedAt'
  > {
    const environmentKey = (this.options.environment ?? process.env)[GEMINI_API_KEY_ENV]?.trim()
    const persistedKey = this.decryptSecret(this.persisted?.encryptedGeminiApiKey)
    const defaults = defaultYoutubeGeminiSettingsValues()
    return {
      geminiApiKeyConfigured: Boolean(environmentKey || persistedKey),
      geminiSource: environmentKey ? 'environment' : persistedKey ? 'persisted' : 'default',
      geminiStatus: this.geminiStatus,
      geminiModel: this.persisted?.geminiModel ?? YOUTUBE_GEMINI_MODEL,
      ...(this.geminiLastCheckedAt ? { geminiLastCheckedAt: this.geminiLastCheckedAt } : {}),
      ...(this.geminiValidationError ? { geminiError: this.geminiValidationError } : {}),
      geminiDailyVideoMinutesLimit:
        this.persisted?.geminiDailyVideoMinutesLimit ?? defaults.geminiDailyVideoMinutesLimit,
      geminiConfirmationThresholdMinutes:
        this.persisted?.geminiConfirmationThresholdMinutes
        ?? defaults.geminiConfirmationThresholdMinutes,
      geminiBudgetWindow: YOUTUBE_GEMINI_BUDGET_WINDOW,
      geminiPricingVerifiedAt: GEMINI_PRICING_METADATA.verifiedAt,
    }
  }

  private runtimeFromState(): {
    readonly values: YoutubeSettingsValues
    readonly source: YoutubeSettingsSource
    readonly apiToken?: string
    readonly password?: string
  } {
    const environment = this.options.environment ?? process.env
    if (hasEnvironmentOverride(environment)) {
      const apiToken = environment[WEBSHARE_API_KEY_ENV]?.trim()
      const username = environment[WEBSHARE_USERNAME_ENV]?.trim() ?? ''
      const password = environment[WEBSHARE_PASSWORD_ENV]?.trim()
      const port = parseEnvironmentPort(environment[WEBSHARE_PROXY_PORT_ENV])
      const countryList = environment[WEBSHARE_PROXY_COUNTRIES_ENV]
      const countries = countryList
        ? normalizeCountries(countryList.split(','))
        : undefined
      const values = normalizeYoutubeSettingsValues({
        proxyEnabled: Boolean(apiToken || (username && password)),
        credentialMode: apiToken ? 'api-token' : 'username-password',
        proxyHost: environment[WEBSHARE_PROXY_HOST_ENV]?.trim() || DEFAULT_WEBSHARE_PROXY_HOST,
        proxyPort: port ?? DEFAULT_WEBSHARE_PROXY_PORT,
        countries: countries ?? ['us'],
        username,
      })
      return {
        values,
        source: 'environment',
        ...(apiToken ? { apiToken } : {}),
        ...(password ? { password } : {}),
      }
    }
    if (this.persisted) {
      const apiToken = this.decryptSecret(this.persisted.encryptedApiToken)
      const password = this.decryptSecret(this.persisted.encryptedPassword)
      return {
        values: normalizeYoutubeSettingsValues(this.persisted),
        source: 'persisted',
        ...(apiToken ? { apiToken } : {}),
        ...(password ? { password } : {}),
      }
    }
    return { values: defaultYoutubeSettingsValues(), source: 'default' }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loadPromise ??= this.load()
    try {
      await this.loadPromise
      this.loaded = true
    } finally {
      this.loadPromise = null
    }
  }

  private async load(): Promise<void> {
    if (!this.options.storagePath) return
    let content: string
    try {
      content = await fs.readFile(this.options.storagePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      const isCurrent = parsed.settingsSchemaVersion === YOUTUBE_SETTINGS_SCHEMA_VERSION
      if (!isCurrent) {
        throw new Error('YouTube settings file version is unsupported.')
      }
      const values = normalizeYoutubeSettingsValues({
        proxyEnabled: parsed.proxyEnabled === true,
        credentialMode: parsed.credentialMode as YoutubeSettingsValues['credentialMode'],
        proxyHost: String(parsed.proxyHost ?? ''),
        proxyPort: Number(parsed.proxyPort),
        countries: Array.isArray(parsed.countries)
          ? parsed.countries.map(String)
          : [],
        username: String(parsed.username ?? ''),
      })
      const geminiDefaults = defaultYoutubeGeminiSettingsValues()
      const geminiValues = normalizeYoutubeGeminiSettingsValues({
        geminiModel: typeof parsed.geminiModel === 'string' &&
          isYoutubeGeminiVideoAnalysisModel(parsed.geminiModel)
          ? parsed.geminiModel
          : geminiDefaults.geminiModel,
        geminiDailyVideoMinutesLimit: Number(parsed.geminiDailyVideoMinutesLimit),
        geminiConfirmationThresholdMinutes: Number(parsed.geminiConfirmationThresholdMinutes),
      })
      for (const encryptedSecret of [
        parsed.encryptedApiToken,
        parsed.encryptedPassword,
        parsed.encryptedGeminiApiKey,
      ]) {
        if (typeof encryptedSecret === 'string') this.decryptSecret(encryptedSecret)
      }
      this.persisted = {
        settingsSchemaVersion: YOUTUBE_SETTINGS_SCHEMA_VERSION,
        ...values,
        ...geminiValues,
        deleteVideosAfterInfoExtraction: parsed.deleteVideosAfterInfoExtraction === true,
        ...(typeof parsed.encryptedApiToken === 'string'
          ? { encryptedApiToken: parsed.encryptedApiToken }
          : {}),
        ...(typeof parsed.encryptedPassword === 'string'
          ? { encryptedPassword: parsed.encryptedPassword }
          : {}),
        ...(typeof parsed.encryptedGeminiApiKey === 'string'
          ? { encryptedGeminiApiKey: parsed.encryptedGeminiApiKey }
          : {}),
      }
    } catch {
      await this.quarantineInvalidSettings()
      this.persisted = undefined
      this.proxyStatus = 'error'
      this.validationError = 'Invalid saved YouTube settings were quarantined and reset.'
    }
  }

  private async quarantineInvalidSettings(): Promise<void> {
    if (!this.options.storagePath) return
    const parsed = path.parse(this.options.storagePath)
    const timestamp = this.now().toISOString().replace(/[:.]/g, '-')
    const quarantinePath = path.join(
      parsed.dir,
      `${parsed.name}.corrupt-${timestamp}-${randomUUID()}${parsed.ext}`,
    )
    await fs.rename(this.options.storagePath, quarantinePath)
  }

  private async persist(settings: PersistedYoutubeSettings): Promise<void> {
    if (!this.options.storagePath) {
      throw new Error('YouTube settings persistence is unavailable.')
    }
    const directory = path.dirname(this.options.storagePath)
    const createdDirectory = await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    if (createdDirectory !== undefined) await fs.chmod(directory, 0o700)
    await writeFileAtomic(
      this.options.storagePath,
      `${JSON.stringify(settings, null, 2)}\n`,
    )
    await fs.chmod(this.options.storagePath, 0o600)
  }

  private encryptSecret(value: string): string {
    if (!this.options.secretCodec) {
      throw new Error('Secure credential storage is unavailable.')
    }
    return this.options.secretCodec.encrypt(value)
  }

  private decryptSecret(value?: string): string {
    if (!value || !this.options.secretCodec) return ''
    return this.options.secretCodec.decrypt(value)
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.writeQueue.then(operation)
    this.writeQueue = running.then(() => undefined, () => undefined)
    return running
  }
}

function createDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
  }, timeoutMs)
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    clear: () => clearTimeout(timer),
  }
}

function hasEnvironmentOverride(environment: NodeJS.ProcessEnv): boolean {
  return [
    WEBSHARE_API_KEY_ENV,
    WEBSHARE_USERNAME_ENV,
    WEBSHARE_PASSWORD_ENV,
    WEBSHARE_PROXY_HOST_ENV,
    WEBSHARE_PROXY_PORT_ENV,
    WEBSHARE_PROXY_COUNTRIES_ENV,
  ].some((name) => Boolean(environment[name]?.trim()))
}

function parseEnvironmentPort(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('WEBSHARE_PROXY_PORT must be between 1 and 65535.')
  }
  return port
}
