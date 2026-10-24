import * as fs from "node:fs/promises";
import * as path from "node:path";

import { writeFileAtomic } from "../core/file-mutation.js";
import type { ProviderSecretCodec } from "./provider-settings-service.js";
import type {
  ProviderModelSelection,
  ProviderSettingsSnapshot,
} from "../domains/provider/provider-settings.js";
import type { CloudBrowserAcquirer } from "../domains/browser/cloud-browser-acquirer.js";
import { parseCloudBrowserEnvironment } from "../domains/browser/cloud-browser-environment.js";
import type { CloudSessionCleanupWarning } from "../domains/browser/cloud-browser-types.js";
import {
  ACQUISITION_PROVIDER_IDS,
  ACQUISITION_SETTINGS_SCHEMA_VERSION,
  DEFAULT_ACQUISITION_BUDGETS,
  validateAcquisitionSettingsUpdate,
  type AcquisitionBudgets,
  type AcquisitionProviderSettingsView,
  type AcquisitionSettingsSnapshot,
  type AcquisitionSettingsUpdate,
} from "../domains/acquisition/acquisition-settings.js";
import {
  BraveSearchProvider,
  ExaSearchProvider,
  FirecrawlReaderProvider,
  type AcquisitionProviderId,
  type ManagedReaderProvider,
  type SearchProvider,
} from "../domains/acquisition/acquisition-providers.js";

interface PersistedProvider {
  enabled: boolean;
  encryptedApiKey?: string;
  status: "unknown" | "connected" | "error";
  error?: string;
  lastCheckedAt?: string;
}

interface AcquisitionSettingsFile {
  schemaVersion: typeof ACQUISITION_SETTINGS_SCHEMA_VERSION;
  providerPriority: Extract<AcquisitionProviderId, "exa" | "brave">[];
  providers: Record<AcquisitionProviderId, PersistedProvider>;
  budgets: AcquisitionBudgets;
  extractionModel: ProviderModelSelection | null;
}

export interface AcquisitionSettingsServiceOptions {
  readonly storagePath?: string;
  readonly secretCodec?: ProviderSecretCodec;
  readonly environment?: NodeJS.ProcessEnv;
  readonly providerEndpoints?: Partial<Record<AcquisitionProviderId, string>>;
  readonly providerSettings?: {
    snapshot(): Promise<ProviderSettingsSnapshot>;
  };
  readonly allowHttpLocalhost?: boolean;
  /**
   * Where a cloud session that could not be confirmed stopped is reported.
   *
   * It is an operator signal about a resource that may still be billing, so it
   * leaves this process rather than sitting in a boolean nobody reads.
   */
  readonly onCloudCleanupWarning?: (warning: CloudSessionCleanupWarning) => void;
}

export class AcquisitionSettingsService {
  private state: AcquisitionSettingsFile | null = null;
  private loadPromise: Promise<AcquisitionSettingsFile> | null = null;
  private source: "default" | "persisted" = "default";
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: AcquisitionSettingsServiceOptions = {},
  ) {}

  async snapshot(): Promise<AcquisitionSettingsSnapshot> {
    const state = await this.ensureLoaded();
    return {
      schemaVersion: ACQUISITION_SETTINGS_SCHEMA_VERSION,
      providerPriority: [...state.providerPriority],
      providers: {
        exa: this.providerView("exa", state.providers.exa),
        brave: this.providerView("brave", state.providers.brave),
        firecrawl: this.providerView("firecrawl", state.providers.firecrawl),
        "browser-use": this.providerView(
          "browser-use",
          state.providers["browser-use"],
        ),
      },
      budgets: { ...state.budgets },
      extractionModel: state.extractionModel
        ? { ...state.extractionModel }
        : null,
      source: this.source,
      editable: Boolean(this.options.storagePath),
    };
  }

  async update(
    input: AcquisitionSettingsUpdate,
  ): Promise<AcquisitionSettingsSnapshot> {
    validateAcquisitionSettingsUpdate(input);
    await this.validateExtractionModel(input.extractionModel);
    return this.enqueue(async () => {
      const state = await this.ensureLoaded();
      for (const provider of ACQUISITION_PROVIDER_IDS) {
        const current = state.providers[provider];
        const update = input.providers[provider];
        if (update.apiKey !== undefined) {
          const key = update.apiKey.trim();
          delete current.encryptedApiKey;
          if (key) current.encryptedApiKey = this.encrypt(key);
          current.status = "unknown";
          delete current.error;
          delete current.lastCheckedAt;
        }
        // Applied after the key, so this reads the credential the caller is
        // storing in the same request. A provider with no credential cannot be
        // on: nothing would run, and the settings screen would show a switch
        // the application ignores.
        current.enabled = update.enabled && this.hasCredential(provider, current);
      }
      state.providerPriority = [...input.providerPriority];
      state.budgets = { ...input.budgets };
      state.extractionModel = input.extractionModel
        ? { ...input.extractionModel }
        : null;
      await this.persist(state);
      this.source = "persisted";
      return this.snapshot();
    });
  }

  async validateProvider(
    provider: AcquisitionProviderId,
  ): Promise<AcquisitionSettingsSnapshot> {
    const credential = await this.credential(provider);
    if (!credential)
      throw new Error(`${providerLabel(provider)} API key is required.`);
    let error: string | undefined;
    try {
      if (provider === "browser-use") {
        await this.validateCloudBrowserCredential(credential);
      } else if (provider === "firecrawl") {
        await this.createManagedReader(credential).acquire(
          "https://example.com/",
          AbortSignal.timeout(30_000),
        );
      } else {
        await this.createSearchProvider(provider, credential).search(
          {
            query: "OpenAI",
            maximumResults: 1,
            includeDomains: [],
            excludeDomains: [],
          },
          AbortSignal.timeout(20_000),
        );
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    await this.enqueue(async () => {
      const state = await this.ensureLoaded();
      state.providers[provider].status = error ? "error" : "connected";
      delete state.providers[provider].error;
      if (error) state.providers[provider].error = error;
      state.providers[provider].lastCheckedAt = new Date().toISOString();
      await this.persist(state);
      this.source = "persisted";
    });
    return this.snapshot();
  }

  async searchProviders(): Promise<readonly SearchProvider[]> {
    const state = await this.ensureLoaded();
    const providers: SearchProvider[] = [];
    for (const provider of state.providerPriority) {
      if (!state.providers[provider].enabled) continue;
      const credential = await this.credential(provider);
      if (credential)
        providers.push(this.createSearchProvider(provider, credential));
    }
    return providers;
  }

  async managedReader(): Promise<ManagedReaderProvider | undefined> {
    const state = await this.ensureLoaded();
    if (!state.providers.firecrawl.enabled) return undefined;
    const credential = await this.credential("firecrawl");
    return credential ? this.createManagedReader(credential) : undefined;
  }

  /**
   * The cloud browser rung, or nothing.
   *
   * Resolved per call, exactly like the managed reader, so turning the provider
   * off or removing its key takes effect without a restart. The call budget is
   * a separate gate: positive limits stop further sessions when reached;
   * zero leaves that dimension unlimited.
   */
  async cloudBrowser(): Promise<CloudBrowserAcquirer | undefined> {
    const state = await this.ensureLoaded();
    if (!state.providers["browser-use"].enabled) return undefined;
    const credential = await this.credential("browser-use");
    if (!credential) return undefined;
    // Validated before anything is constructed, so a mistyped environment
    // runtime input fails here rather than turning into a provider request.
    const runtime = parseCloudBrowserEnvironment(
      this.options.environment ?? process.env,
    );
    // Imported here rather than at module load. The acquirer pulls in
    // `puppeteer-core`, and this service is imported almost everywhere; paying
    // for a browser driver in every process that merely reads settings made the
    // integration suite time out wholesale.
    const [{ CloudBrowserAcquirer }, { BrowserUseSessionClient }, { BrowserNetworkPolicy }] =
      await Promise.all([
        import("../domains/browser/cloud-browser-acquirer.js"),
        import("../domains/browser/browser-use-session-client.js"),
        import("../domains/browser/browser-network-policy.js"),
      ]);
    return new CloudBrowserAcquirer({
      sessionClient: new BrowserUseSessionClient({
        apiKey: credential,
        cdpHostAllowlist: runtime.cdpHostAllowlist,
        ...(runtime.proxyCountryCode === undefined
          ? {}
          : { proxyCountryCode: runtime.proxyCountryCode }),
        ...(this.options.providerEndpoints?.["browser-use"]
          ? { endpoint: this.options.providerEndpoints["browser-use"] }
          : {}),
        ...(this.options.onCloudCleanupWarning
          ? { onCleanupWarning: this.options.onCloudCleanupWarning }
          : {}),
      }),
      networkPolicy: new BrowserNetworkPolicy(
        this.options.allowHttpLocalhost === undefined
          ? {}
          : { allowHttpLocalhost: this.options.allowHttpLocalhost },
      ),
    });
  }

  async budgets(): Promise<AcquisitionBudgets> {
    return { ...(await this.ensureLoaded()).budgets };
  }

  async extractionModel(): Promise<ProviderModelSelection | null> {
    const selection = (await this.ensureLoaded()).extractionModel;
    return selection ? { ...selection } : null;
  }

  private async credential(
    provider: AcquisitionProviderId,
  ): Promise<string | undefined> {
    if (provider !== "browser-use") {
      const environment = this.options.environment ?? process.env;
      const environmentKey = PROVIDER_ENVIRONMENT_KEYS[provider];
      const fromEnvironment = environment[environmentKey]?.trim();
      if (fromEnvironment) return fromEnvironment;
    }
    const encrypted = (await this.ensureLoaded()).providers[provider]
      .encryptedApiKey;
    if (!encrypted) return undefined;
    if (!this.options.secretCodec) {
      throw new Error("Acquisition secret storage is unavailable.");
    }
    return this.options.secretCodec.decrypt(encrypted);
  }

  private async validateCloudBrowserCredential(
    credential: string,
  ): Promise<void> {
    const { BrowserUseSessionClient } = await import(
      "../domains/browser/browser-use-session-client.js"
    );
    await new BrowserUseSessionClient({
      apiKey: credential,
      ...(this.options.providerEndpoints?.["browser-use"]
        ? { endpoint: this.options.providerEndpoints["browser-use"] }
        : {}),
    }).validateCredential();
  }

  private createSearchProvider(
    provider: "exa" | "brave",
    credential: string,
  ): SearchProvider {
    const endpoint = this.options.providerEndpoints?.[provider];
    return provider === "exa"
      ? new ExaSearchProvider(credential, endpoint)
      : new BraveSearchProvider(credential, endpoint);
  }

  private createManagedReader(credential: string): ManagedReaderProvider {
    return new FirecrawlReaderProvider(
      credential,
      this.options.providerEndpoints?.firecrawl,
    );
  }

  private async validateExtractionModel(
    selection: ProviderModelSelection | null,
  ): Promise<void> {
    if (!selection) return;
    if (!this.options.providerSettings) {
      throw new Error(
        "Provider settings are unavailable for extraction-model validation.",
      );
    }
    const snapshot = await this.options.providerSettings.snapshot();
    const available = snapshot.catalog.some(
      (group) =>
        group.provider === selection.provider &&
        group.models.some(
          (model) =>
            model.id === selection.model &&
            model.enabled &&
            (!model.capabilities || model.capabilities.includes("chat")),
        ),
    );
    if (!available) {
      throw new Error("Extraction model must be an enabled chat model.");
    }
  }

  /**
   * Whether this provider has a key to run with, from either source.
   *
   * The environment is not a credential source for Browser Use: that key
   * belongs to the opt-in paid smoke test, so a machine that has it exported
   * must not silently gain a billable rung in the application.
   */
  private hasCredential(
    provider: AcquisitionProviderId,
    persisted: PersistedProvider,
  ): boolean {
    if (persisted.encryptedApiKey) return true;
    if (provider === "browser-use") return false;
    return Boolean(
      (this.options.environment ?? process.env)[
        PROVIDER_ENVIRONMENT_KEYS[provider]
      ]?.trim(),
    );
  }

  private providerView(
    provider: AcquisitionProviderId,
    persisted: PersistedProvider,
  ): AcquisitionProviderSettingsView {
    const hasEnvironmentKey =
      provider === "browser-use"
        ? false
        : Boolean(
            (this.options.environment ?? process.env)[
              PROVIDER_ENVIRONMENT_KEYS[provider]
            ]?.trim(),
          );
    const hasApiKey = hasEnvironmentKey || Boolean(persisted.encryptedApiKey);
    let hint: string | undefined;
    if (hasEnvironmentKey) hint = "Environment";
    else if (persisted.encryptedApiKey) hint = "Saved";
    return {
      // Derived rather than read straight from the file: a stored `true` that
      // predates the key being removed, or a default nobody chose, must not
      // report a provider as on when it cannot run.
      enabled: persisted.enabled && hasApiKey,
      hasApiKey,
      ...(hint ? { keyHint: hint } : {}),
      status: persisted.status,
      ...(persisted.error ? { error: persisted.error } : {}),
      ...(persisted.lastCheckedAt
        ? { lastCheckedAt: persisted.lastCheckedAt }
        : {}),
    };
  }

  private async ensureLoaded(): Promise<AcquisitionSettingsFile> {
    if (this.state) return this.state;
    if (this.loadPromise) return this.loadPromise;
    const loading = this.loadState().finally(() => {
      if (this.loadPromise === loading) this.loadPromise = null;
    });
    this.loadPromise = loading;
    return loading;
  }

  private async loadState(): Promise<AcquisitionSettingsFile> {
    const fallback = defaultState();
    if (!this.options.storagePath) {
      this.state = fallback;
      return fallback;
    }
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.options.storagePath, "utf8"),
      ) as unknown;
      this.state = parseSettingsFile(parsed);
      this.source = "persisted";
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw new Error("Acquisition settings file is invalid.", {
          cause: error,
        });
      }
      this.state = fallback;
    }
    return this.state;
  }

  private encrypt(value: string): string {
    if (!this.options.secretCodec) {
      throw new Error("Encrypted acquisition secret storage is unavailable.");
    }
    return this.options.secretCodec.encrypt(value);
  }

  private async persist(state: AcquisitionSettingsFile): Promise<void> {
    if (!this.options.storagePath) {
      throw new Error("Acquisition settings persistence is unavailable.");
    }
    const directory = path.dirname(this.options.storagePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await writeFileAtomic(
      this.options.storagePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
    await fs.chmod(this.options.storagePath, 0o600);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.writeQueue.then(operation);
    this.writeQueue = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Environment credentials for providers that support application overrides.
 *
 * Browser Use is deliberately absent: its environment key belongs only to the
 * opt-in paid smoke test, while the application reads its key from Settings.
 * A `Record` keeps credential lookup and the settings view on one mapping.
 */
const PROVIDER_ENVIRONMENT_KEYS: Readonly<
  Record<Exclude<AcquisitionProviderId, "browser-use">, string>
> = {
  exa: "EXA_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
};

const OBSOLETE_BROWSER_USE_TEST_WARNING =
  "Testing this provider would start a billable session, so it is not tested from here.";

function defaultState(): AcquisitionSettingsFile {
  return {
    schemaVersion: ACQUISITION_SETTINGS_SCHEMA_VERSION,
    providerPriority: ["exa", "brave"],
    providers: {
      exa: { enabled: true, status: "unknown" },
      brave: { enabled: true, status: "unknown" },
      firecrawl: { enabled: false, status: "unknown" },
      // Off by default: this one costs money when it runs.
      "browser-use": { enabled: false, status: "unknown" },
    },
    budgets: { ...DEFAULT_ACQUISITION_BUDGETS },
    extractionModel: null,
  };
}

function parseSettingsFile(value: unknown): AcquisitionSettingsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Acquisition settings must be an object.");
  }
  const record = value as Record<string, unknown>;
  // Every version this application has ever written. A file on disk is the
  // user's configuration, and refusing to read it because a provider was added
  // later is a worse failure than the new provider being absent.
  if (
    record.schemaVersion !== ACQUISITION_SETTINGS_SCHEMA_VERSION &&
    record.schemaVersion !== 2 &&
    record.schemaVersion !== 1
  ) {
    throw new Error("Acquisition settings use an unsupported schema version.");
  }
  const priority = record.providerPriority;
  const providers = record.providers;
  const budgets = record.budgets;
  if (
    !Array.isArray(priority) ||
    !providers ||
    typeof providers !== "object" ||
    Array.isArray(providers) ||
    !budgets ||
    typeof budgets !== "object" ||
    Array.isArray(budgets)
  ) {
    throw new Error("Acquisition settings are malformed.");
  }
  const parsedProviders = {} as Record<
    AcquisitionProviderId,
    PersistedProvider
  >;
  // Only a file written before a provider existed may omit it. A current file
  // missing one is damaged, and reading that as "off" would quietly discard a
  // setting somebody made.
  const predatesCloudProvider = record.schemaVersion !== ACQUISITION_SETTINGS_SCHEMA_VERSION;
  for (const provider of ACQUISITION_PROVIDER_IDS) {
    const input = (providers as Record<string, unknown>)[provider];
    if (input === undefined && provider === "browser-use" && predatesCloudProvider) {
      // Absent means disabled, which is the safe default for a paid rung.
      parsedProviders[provider] = { enabled: false, status: "unknown" };
      continue;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`Acquisition provider '${provider}' is malformed.`);
    }
    const providerRecord = input as Record<string, unknown>;
    if (
      typeof providerRecord.enabled !== "boolean" ||
      !["unknown", "connected", "error"].includes(
        String(providerRecord.status),
      ) ||
      (providerRecord.encryptedApiKey !== undefined &&
        typeof providerRecord.encryptedApiKey !== "string") ||
      (providerRecord.error !== undefined &&
        typeof providerRecord.error !== "string") ||
      (providerRecord.lastCheckedAt !== undefined &&
        (typeof providerRecord.lastCheckedAt !== "string" ||
          !Number.isFinite(Date.parse(providerRecord.lastCheckedAt))))
    ) {
      throw new Error(`Acquisition provider '${provider}' is invalid.`);
    }
    const obsoleteBrowserUseWarning =
      provider === "browser-use" &&
      providerRecord.error === OBSOLETE_BROWSER_USE_TEST_WARNING;
    parsedProviders[provider] = {
      enabled: providerRecord.enabled,
      status:
        providerRecord.status === "unknown" ||
        providerRecord.status === "connected" ||
        providerRecord.status === "error"
          ? providerRecord.status
          : unreachableProviderStatus(),
      ...(providerRecord.encryptedApiKey === undefined
        ? {}
        : { encryptedApiKey: providerRecord.encryptedApiKey }),
      ...(providerRecord.error === undefined || obsoleteBrowserUseWarning
        ? {}
        : { error: providerRecord.error }),
      ...(providerRecord.lastCheckedAt === undefined || obsoleteBrowserUseWarning
        ? {}
        : { lastCheckedAt: providerRecord.lastCheckedAt }),
    };
  }
  // A budget a *previous* version never wrote takes its default. A current file
  // is expected to carry all of them, and validation below rejects it if not.
  const parsedBudgets: AcquisitionBudgets = {
    ...(predatesCloudProvider
      ? {
          maximumCloudBrowserCalls:
            DEFAULT_ACQUISITION_BUDGETS.maximumCloudBrowserCalls,
          maximumCloudBrowserCostMicros:
            DEFAULT_ACQUISITION_BUDGETS.maximumCloudBrowserCostMicros,
        }
      : {}),
    ...(record.schemaVersion === 1
      ? {
          maximumModelExtractions:
            DEFAULT_ACQUISITION_BUDGETS.maximumModelExtractions,
        }
      : {}),
    ...(budgets as Partial<AcquisitionBudgets>),
  } as AcquisitionBudgets;
  const update: AcquisitionSettingsUpdate = {
    providerPriority: priority as ("exa" | "brave")[],
    providers: {
      exa: { enabled: parsedProviders.exa.enabled },
      brave: { enabled: parsedProviders.brave.enabled },
      firecrawl: { enabled: parsedProviders.firecrawl.enabled },
      "browser-use": { enabled: parsedProviders["browser-use"].enabled },
    },
    budgets: parsedBudgets,
    extractionModel:
      record.schemaVersion === 1
        ? null
        : parseModelSelection(record.extractionModel),
  };
  validateAcquisitionSettingsUpdate(update);
  return {
    schemaVersion: ACQUISITION_SETTINGS_SCHEMA_VERSION,
    providerPriority: [...update.providerPriority],
    providers: parsedProviders,
    budgets: { ...update.budgets },
    extractionModel: update.extractionModel
      ? { ...update.extractionModel }
      : null,
  };
}

function unreachableProviderStatus(): never {
  throw new Error("Acquisition provider status is invalid.");
}

function parseModelSelection(value: unknown): ProviderModelSelection | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Extraction model selection is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "provider" && key !== "model") ||
    typeof record.provider !== "string" ||
    typeof record.model !== "string"
  ) {
    throw new Error("Extraction model selection is malformed.");
  }
  return { provider: record.provider, model: record.model };
}

const PROVIDER_LABELS: Readonly<Record<AcquisitionProviderId, string>> = {
  exa: "Exa",
  brave: "Brave Search",
  firecrawl: "Firecrawl",
  "browser-use": "Browser Use",
};

function providerLabel(provider: AcquisitionProviderId): string {
  // A record rather than a chain of ternaries, whose final `else` had already
  // started calling the new provider "Firecrawl" in user-facing errors.
  return PROVIDER_LABELS[provider];
}
