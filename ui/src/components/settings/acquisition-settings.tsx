import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FieldHelp } from "@/components/ui/field-help";
import { Input } from "@/components/ui/input";
import { ModelSelect } from "@/components/ui/model-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchAcquisitionSettings,
  saveAcquisitionSettings,
  validateAcquisitionProvider,
  type AcquisitionProviderId,
  type AcquisitionSettingsSnapshot,
} from "@/lib/clients/acquisition-settings-client";

type BudgetKey = keyof AcquisitionSettingsSnapshot["budgets"];
type BudgetDraft = Record<BudgetKey, string>;
type ExtractionModel = AcquisitionSettingsSnapshot["extractionModel"];

const PROVIDERS: readonly {
  id: AcquisitionProviderId;
  label: string;
  homepage: string;
}[] = [
  { id: "exa", label: "Exa", homepage: "https://exa.ai" },
  { id: "brave", label: "Brave Search", homepage: "https://brave.com/search/api/" },
  { id: "firecrawl", label: "Firecrawl", homepage: "https://www.firecrawl.dev" },
  { id: "browser-use", label: "Browser Use", homepage: "https://browser-use.com" },
];

const SEARCH_PROVIDERS = ["exa", "brave"] as const;

type SearchProviderId = (typeof SEARCH_PROVIDERS)[number];

/**
 * Every ceiling, with the bounds the server enforces and the sentence that
 * explains it. A budget nobody can read is a budget nobody sets on purpose,
 * and two of these silently decide whether the paid rung runs at all.
 */
const BUDGET_FIELDS: readonly {
  key: BudgetKey;
  id: string;
  label: string;
  minimum: number;
  maximum: number;
  help: string;
}[] = [
  {
    key: "maximumSearchCalls",
    id: "acquisition-search-calls",
    label: "Search calls",
    minimum: 1,
    maximum: 100,
    help: "How many search requests one research assignment may make. Once it is reached the assignment carries on with what it already found.",
  },
  {
    key: "maximumBrowserFallbacks",
    id: "acquisition-chrome-fallbacks",
    label: "Chrome fallbacks",
    minimum: 0,
    maximum: 50,
    help: "How many pages one assignment may re-read in the local Chrome browser when plain HTTP cannot render them. Zero keeps every read on plain HTTP.",
  },
  {
    key: "maximumManagedReaderCalls",
    id: "acquisition-managed-reader-calls",
    label: "Managed-reader calls",
    minimum: 0,
    maximum: 50,
    help: "How many pages one assignment may send to Firecrawl, the paid managed reader. Zero keeps the managed reader off.",
  },
  {
    key: "maximumModelExtractions",
    id: "acquisition-model-extractions",
    label: "Model extractions",
    minimum: 0,
    maximum: 100,
    help: "How many times one assignment may call the extraction model, used only when stored JSON, metadata and tables cannot answer the requested schema. Zero keeps extraction deterministic.",
  },
  {
    key: "maximumCloudBrowserCalls",
    id: "acquisition-cloud-browser-calls",
    label: "Cloud browser calls",
    minimum: 0,
    maximum: 20,
    help: "How many paid Browser Use sessions one assignment may start. Zero means no call limit. The provider must still be enabled.",
  },
  {
    key: "maximumCloudBrowserCostMicros",
    id: "acquisition-cloud-browser-cost",
    label: "Cloud browser spend threshold",
    minimum: 0,
    maximum: 100000000,
    help: "A stop threshold in USD micros, where 1,000,000 micros is one US dollar. Once an assignment's confirmed cloud spend reaches this figure it starts no further sessions, and zero means no spend threshold.",
  },
];

/**
 * One change the user just made, on its way to the server.
 *
 * Every field saves itself, so a save is described by what moved rather than by
 * a form submission. Absent members keep the value already on screen.
 */
interface AcquisitionChange {
  enabled?: Record<AcquisitionProviderId, boolean>;
  primary?: SearchProviderId;
  budgets?: BudgetDraft;
  extractionModel?: ExtractionModel;
  apiKey?: { provider: AcquisitionProviderId; value: string };
}

export function AcquisitionSettings() {
  const [snapshot, setSnapshot] = useState<AcquisitionSettingsSnapshot | null>(null);
  const [enabled, setEnabled] = useState<Record<AcquisitionProviderId, boolean>>({
    exa: true,
    brave: true,
    firecrawl: false,
    "browser-use": false,
  });
  const [keys, setKeys] = useState<Record<AcquisitionProviderId, string>>({
    exa: "",
    brave: "",
    firecrawl: "",
    "browser-use": "",
  });
  const [primary, setPrimary] = useState<SearchProviderId>("exa");
  const [budgets, setBudgets] = useState<BudgetDraft>({
    maximumSearchCalls: "20",
    maximumBrowserFallbacks: "10",
    maximumManagedReaderCalls: "5",
    maximumModelExtractions: "20",
    maximumCloudBrowserCalls: "0",
    maximumCloudBrowserCostMicros: "0",
  });
  const [extractionModel, setExtractionModel] = useState<ExtractionModel>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validating, setValidating] = useState<AcquisitionProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Writes are chained rather than fired in parallel: two fields changed in
  // quick succession must reach the server in the order they were changed, and
  // "Test" has to run after the key it is about to check has landed.
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  // Pressing Enter in a key field and then leaving it are one intention. The
  // input still holds the text until the save answers, so without this the
  // blur would store the same key a second time.
  const submittedKeys = useRef<Record<AcquisitionProviderId, string>>({
    exa: "",
    brave: "",
    firecrawl: "",
    "browser-use": "",
  });
  const keyWrites = useRef<
    Record<AcquisitionProviderId, Promise<boolean> | undefined>
  >({
    exa: undefined,
    brave: undefined,
    firecrawl: undefined,
    "browser-use": undefined,
  });

  /**
   * The server's answer becomes the drafts, once, on load.
   *
   * Later responses only replace `snapshot`. Overwriting the drafts with them
   * would let a save that is still in flight reset a field the user has typed
   * into since.
   */
  function adoptSnapshot(next: AcquisitionSettingsSnapshot): void {
    setSnapshot(next);
    setEnabled({
      exa: next.providers.exa.enabled,
      brave: next.providers.brave.enabled,
      firecrawl: next.providers.firecrawl.enabled,
      "browser-use": next.providers["browser-use"].enabled,
    });
    setPrimary(next.providerPriority[0] ?? "exa");
    setBudgets({
      maximumSearchCalls: String(next.budgets.maximumSearchCalls),
      maximumBrowserFallbacks: String(next.budgets.maximumBrowserFallbacks),
      maximumManagedReaderCalls: String(next.budgets.maximumManagedReaderCalls),
      maximumModelExtractions: String(next.budgets.maximumModelExtractions),
      maximumCloudBrowserCalls: String(next.budgets.maximumCloudBrowserCalls),
      maximumCloudBrowserCostMicros: String(
        next.budgets.maximumCloudBrowserCostMicros,
      ),
    });
    setExtractionModel(next.extractionModel);
    setKeys({ exa: "", brave: "", firecrawl: "", "browser-use": "" });
    setError(null);
  }

  useEffect(() => {
    let active = true;
    void fetchAcquisitionSettings()
      .then((next) => {
        if (!active) return;
        adoptSnapshot(next);
      })
      .catch((requestError: unknown) => {
        if (active) setError(messageOf(requestError));
      });
    return () => {
      active = false;
    };
  }, []);

  // A search provider holding the only key is the only one that can run a
  // search, so it owns the priority list whatever the dropdown last said.
  const keyedSearchProviders = SEARCH_PROVIDERS.filter(
    (id) => Boolean(keys[id].trim()) || Boolean(snapshot?.providers[id].hasApiKey),
  );
  const soleKeyedProvider =
    keyedSearchProviders.length === 1 ? keyedSearchProviders[0] ?? null : null;
  const activePrimary = soleKeyedProvider ?? primary;

  function save(change: AcquisitionChange): Promise<boolean> {
    if (!snapshot?.editable) return Promise.resolve(false);
    const nextEnabled = change.enabled ?? enabled;
    const nextBudgets = change.budgets ?? budgets;
    const nextModel =
      change.extractionModel === undefined ? extractionModel : change.extractionModel;
    const keyChange = change.apiKey;
    // A field halfway through being retyped is not a number yet. Sending the
    // stored value for that one field keeps a switch flipped in the meantime
    // from being dropped, which is the failure this whole screen is fixing.
    const budgetOf = (key: BudgetKey): number => {
      const field = BUDGET_FIELDS.find((candidate) => candidate.key === key);
      return field && validBudget(nextBudgets, field)
        ? Number(nextBudgets[key])
        : snapshot.budgets[key];
    };

    const keyed = SEARCH_PROVIDERS.filter((id) =>
      keyChange?.provider === id
        ? Boolean(keyChange.value)
        : Boolean(keys[id].trim()) || Boolean(snapshot.providers[id].hasApiKey),
    );
    const soleKeyed = keyed.length === 1 ? keyed[0] : undefined;
    const head = soleKeyed ?? change.primary ?? primary;
    if (keyChange && soleKeyed) setPrimary(soleKeyed);
    const providerUpdate = (id: AcquisitionProviderId) => ({
      enabled: nextEnabled[id],
      ...(keyChange?.provider === id ? { apiKey: keyChange.value } : {}),
    });

    setSaving(true);
    setSaved(false);
    setError(null);
    inFlight.current += 1;
    const run = writes.current.then(async () => {
      try {
        setSnapshot(
          await saveAcquisitionSettings({
            providerPriority: [head, head === "exa" ? "brave" : "exa"],
            providers: {
              exa: providerUpdate("exa"),
              brave: providerUpdate("brave"),
              firecrawl: providerUpdate("firecrawl"),
              "browser-use": providerUpdate("browser-use"),
            },
            budgets: {
              maximumSearchCalls: budgetOf("maximumSearchCalls"),
              maximumBrowserFallbacks: budgetOf("maximumBrowserFallbacks"),
              maximumManagedReaderCalls: budgetOf("maximumManagedReaderCalls"),
              maximumModelExtractions: budgetOf("maximumModelExtractions"),
              maximumCloudBrowserCalls: budgetOf("maximumCloudBrowserCalls"),
              maximumCloudBrowserCostMicros: budgetOf(
                "maximumCloudBrowserCostMicros",
              ),
            },
            extractionModel: nextModel,
          }),
        );
        if (keyChange) {
          // Only the text this request carried is cleared. A correction typed
          // while it was in flight is the newer intention and stays put.
          setKeys((current) =>
            current[keyChange.provider].trim() === keyChange.value
              ? { ...current, [keyChange.provider]: "" }
              : current,
          );
        }
        // A save that worked ends any message an earlier one left behind. The
        // clearing at enqueue time cannot: a queued save clears the message
        // before the request ahead of it has had the chance to fail.
        setError(null);
        setSaved(true);
        return true;
      } catch (requestError) {
        setError(messageOf(requestError));
        return false;
      } finally {
        // Released whether it worked or not, so the same key can be sent again
        // by leaving the field. Guarded because a newer key may already have
        // claimed the marker, and an older request must not release that.
        if (keyChange && submittedKeys.current[keyChange.provider] === keyChange.value) {
          submittedKeys.current[keyChange.provider] = "";
        }
        inFlight.current -= 1;
        if (inFlight.current === 0) setSaving(false);
      }
    });
    writes.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function saveBudget(key: BudgetKey): void {
    if (!snapshot) return;
    const field = BUDGET_FIELDS.find((candidate) => candidate.key === key);
    if (!field || !validBudget(budgets, field)) return;
    if (Number(budgets[key]) === snapshot.budgets[key]) return;
    void save({ budgets });
  }

  function saveKey(provider: AcquisitionProviderId): void {
    const value = keys[provider].trim();
    if (!value || submittedKeys.current[provider] === value) return;
    submittedKeys.current[provider] = value;
    keyWrites.current[provider] = save({ apiKey: { provider, value } });
  }

  /**
   * Validation checks the key the server holds, so it waits for the save the
   * field's own blur already started rather than storing the key a second time.
   */
  async function test(provider: AcquisitionProviderId): Promise<void> {
    if (!snapshot) return;
    setValidating(provider);
    setSaved(false);
    setError(null);
    try {
      const keyWrite = keyWrites.current[provider];
      if (keyWrite && !(await keyWrite)) return;
      await writes.current;
      setSnapshot(await validateAcquisitionProvider(provider));
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setValidating(null);
    }
  }

  const locked = validating !== null || !snapshot?.editable;

  return (
    <section className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-5">
      <div className="flex items-center gap-1">
        <h3 className="text-lg font-semibold">Search and acquisition</h3>
        <FieldHelp label="About search and acquisition" contentClassName="max-w-96">
          Search uses complementary indexes. Source reading starts with safe direct
          HTTP, escalates to Chrome when rendering is needed, and can optionally use
          a managed reader. External providers require your own API key and may charge
          for usage. Search snippets are never accepted as evidence. Every change on
          this page saves itself.
        </FieldHelp>
      </div>

      {!snapshot && !error ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          Loading acquisition settings...
        </p>
      ) : null}

      {snapshot ? (
        <>
          <Table containerClassName="border-border/70 bg-background/60">
            <TableHeader>
              <TableRow className="text-xs font-medium tracking-wide text-muted-foreground uppercase hover:bg-transparent">
                <TableHead scope="col" className="px-4 py-2 text-left">Provider</TableHead>
                <TableHead scope="col" className="w-full px-4 py-2 text-left">API key</TableHead>
                <TableHead scope="col" className="px-4 py-2 text-right">Connection</TableHead>
                <TableHead scope="col" className="px-4 py-2 text-right">On/off</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
                {PROVIDERS.map(({ id, label, homepage }) => {
                  const provider = snapshot.providers[id];
                  const draftKey = keys[id].trim();
                  return (
                    <TableRow key={id} className="border-border/70 hover:bg-transparent">
                      <TableCell className="px-4 py-2.5">
                        <a
                          className="font-medium whitespace-nowrap hover:underline"
                          href={homepage}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {label}
                        </a>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <Input
                          aria-label={`${label} API key`}
                          type="password"
                          autoComplete="off"
                          className="min-w-56"
                          placeholder={provider.hasApiKey ? `${provider.keyHint ?? "Saved"} key configured` : "API key"}
                          value={keys[id]}
                          disabled={locked}
                          onChange={(event) =>
                            setKeys((current) => ({ ...current, [id]: event.target.value }))
                          }
                          onBlur={() => saveKey(id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") saveKey(id);
                          }}
                        />
                        {provider.error ? (
                          <p className="mt-1 text-xs text-destructive">{provider.error}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                          <span className="text-xs text-muted-foreground">
                            {connectionLabel(provider, draftKey)}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={
                              (!provider.hasApiKey && !draftKey) || validating !== null || locked
                            }
                            onClick={() => void test(id)}
                          >
                            {validating === id ? <Loader2 className="size-4 animate-spin" /> : null}
                            Test
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex justify-end">
                          <Switch
                            aria-label={`Enable ${label}`}
                            checked={enabled[id]}
                            disabled={locked || !provider.hasApiKey}
                            onCheckedChange={(checked) => {
                              const next = { ...enabled, [id]: checked };
                              setEnabled(next);
                              void save({ enabled: next });
                            }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>

          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <div className="flex flex-col gap-2">
              <div className="flex min-h-9 items-end gap-1">
                <label
                  className="text-sm leading-tight font-medium"
                  htmlFor="acquisition-primary-provider"
                >
                  Primary search provider
                </label>
                <FieldHelp label="About primary search provider">
                  Search hits this index first and falls back to the other one. When
                  only one of Exa or Brave Search has a key, that provider is used
                  automatically and this choice is locked.
                </FieldHelp>
              </div>
              <Select
                value={activePrimary}
                disabled={locked || soleKeyedProvider !== null}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  const next = toSearchProvider(value);
                  setPrimary(next);
                  void save({ primary: next });
                }}
              >
                <SelectTrigger id="acquisition-primary-provider" className="w-full">
                  <SelectValue>
                    {(value) => value === "brave" ? "Brave Search" : "Exa"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exa">Exa</SelectItem>
                  <SelectItem value="brave">Brave Search</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {BUDGET_FIELDS.map((field) => (
              <BudgetField
                key={field.key}
                id={field.id}
                label={field.label}
                help={field.help}
                value={budgets[field.key]}
                minimum={field.minimum}
                maximum={field.maximum}
                disabled={locked}
                invalid={!validBudget(budgets, field)}
                onChange={(value) =>
                  setBudgets((current) => ({ ...current, [field.key]: value }))
                }
                onCommit={() => saveBudget(field.key)}
              />
            ))}
          </div>

          <div className="space-y-3 rounded-lg border border-border/70 bg-background/60 p-4">
            <div className="flex items-center gap-1">
              <h4 className="text-sm font-medium">Dedicated extraction model</h4>
              <FieldHelp label="About dedicated extraction model">
                Used only when stored JSON, metadata, and tables cannot satisfy the
                requested schema. Deterministic extraction remains available without it.
              </FieldHelp>
            </div>
            <div className="flex max-w-xl items-center gap-2">
              <ModelSelect
                aria-label="Dedicated extraction model"
                provider={extractionModel?.provider}
                model={extractionModel?.model}
                disabled={locked}
                placeholder="Select extraction model"
                onChange={(choice) => {
                  setExtractionModel(choice);
                  void save({ extractionModel: choice });
                }}
              />
              {extractionModel ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    setExtractionModel(null);
                    void save({ extractionModel: null });
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>

          <div aria-live="polite" className="min-h-5 text-sm">
            {error ? (
              <p className="flex items-center gap-2 text-destructive" role="alert">
                <CircleAlert className="size-4" />
                {error}
              </p>
            ) : saving ? (
              <p className="flex items-center gap-2 text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </p>
            ) : saved ? (
              <p className="flex items-center gap-2 text-emerald-600" role="status">
                <CheckCircle2 className="size-4" />
                Acquisition settings saved.
              </p>
            ) : null}
          </div>
        </>
      ) : error ? (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <CircleAlert className="size-4" />
          {error}
        </p>
      ) : null}
    </section>
  );
}

function BudgetField(props: {
  id: string;
  label: string;
  help: string;
  value: string;
  minimum: number;
  maximum: number;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-9 items-end gap-1">
        <label className="text-sm leading-tight font-medium" htmlFor={props.id}>
          {props.label}
        </label>
        <FieldHelp label={`About ${props.label.toLowerCase()}`}>{props.help}</FieldHelp>
      </div>
      <Input
        id={props.id}
        type="number"
        min={props.minimum}
        max={props.maximum}
        step={1}
        aria-invalid={props.invalid}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={() => props.onCommit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onCommit();
        }}
      />
      {props.invalid ? (
        <p className="text-xs text-destructive">
          Enter a whole number from {props.minimum} to {props.maximum}.
        </p>
      ) : null}
    </div>
  );
}

function connectionLabel(
  provider: AcquisitionSettingsSnapshot["providers"][AcquisitionProviderId],
  draftKey: string,
): string {
  if (draftKey) return "Unsaved key";
  if (provider.status === "connected") return "Connected";
  if (provider.status === "error") return "Connection error";
  return provider.hasApiKey ? "Not checked" : "Key required";
}

function toSearchProvider(value: string): SearchProviderId {
  return value === "brave" ? "brave" : "exa";
}

function validBudget(
  draft: BudgetDraft,
  field: { key: BudgetKey; minimum: number; maximum: number },
): boolean {
  const value = draft[field.key];
  return /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= field.minimum &&
    Number(value) <= field.maximum;
}

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Research acquisition settings could not be loaded or saved.";
}
