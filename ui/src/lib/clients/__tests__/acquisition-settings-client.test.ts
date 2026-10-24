import { afterEach, expect, it, vi } from "vitest";

import {
  fetchAcquisitionSettings,
  saveAcquisitionSettings,
  validateAcquisitionProvider,
  type AcquisitionSettingsSnapshot,
} from "@/lib/clients/acquisition-settings-client";

const snapshot: AcquisitionSettingsSnapshot = {
  schemaVersion: 3,
  providerPriority: ["exa", "brave"],
  providers: {
    exa: { enabled: true, hasApiKey: true, keyHint: "Saved", status: "unknown" },
    brave: { enabled: true, hasApiKey: false, status: "unknown" },
    firecrawl: { enabled: false, hasApiKey: false, status: "unknown" },
    "browser-use": { enabled: false, hasApiKey: false, status: "unknown" },
  },
  budgets: {
    maximumSearchCalls: 20,
    maximumBrowserFallbacks: 10,
    maximumManagedReaderCalls: 5,
    maximumModelExtractions: 20,
    maximumCloudBrowserCalls: 0,
    maximumCloudBrowserCostMicros: 0,
  },
  extractionModel: null,
  source: "persisted",
  editable: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The snapshot as plain data, so a case can damage one field of it. */
function payload(): Record<string, unknown> {
  const copy: unknown = JSON.parse(JSON.stringify(snapshot));
  if (!isRecord(copy)) throw new Error("The snapshot fixture is not an object");
  return copy;
}

function overBudget(key: string, value: number): Record<string, unknown> {
  const body = payload();
  return { ...body, budgets: { ...(body.budgets as object), [key]: value } };
}

async function fetchWith(body: unknown): Promise<unknown> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  return fetchAcquisitionSettings();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses the acquisition settings, save, and live validation contracts", async () => {
  const fetchMock = vi.fn(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    void input;
    void init;
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(fetchAcquisitionSettings()).resolves.toEqual(snapshot);
  await saveAcquisitionSettings({
    providerPriority: ["exa", "brave"],
    providers: {
      exa: { enabled: true, apiKey: "new-key" },
      brave: { enabled: true },
      firecrawl: { enabled: false },
      "browser-use": { enabled: false },
    },
    budgets: snapshot.budgets,
    extractionModel: null,
  });
  await validateAcquisitionProvider("exa");

  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings/research-acquisition");
  expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
  expect(fetchMock.mock.calls[2]?.[0]).toBe(
    "/api/settings/research-acquisition/validate",
  );
  expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
    provider: "exa",
  });
});

it("accepts a complete snapshot", async () => {
  await expect(fetchWith(payload())).resolves.toEqual(snapshot);
});

it("refuses a snapshot whose declared shape is incomplete or malformed", async () => {
  // Each case is a payload a stale or wrong server could really return. The
  // renderer reads these fields directly, so a guard that certifies a type it
  // never checked is worse than no guard: it launders the payload.
  const cases: Record<string, () => Record<string, unknown>> = {
    "missing schemaVersion": () => {
      const body = payload();
      delete body.schemaVersion;
      return body;
    },
    "unknown schemaVersion": () => ({ ...payload(), schemaVersion: 99 }),
    "missing extractionModel": () => {
      const body = payload();
      delete body.extractionModel;
      return body;
    },
    "malformed extractionModel": () => ({
      ...payload(),
      extractionModel: { provider: "openai" },
    }),
    "priority with a duplicate": () => ({
      ...payload(),
      providerPriority: ["exa", "exa"],
    }),
    "priority naming an unknown provider": () => ({
      ...payload(),
      providerPriority: ["exa", "firecrawl"],
    }),
    "missing cloud provider": () => {
      const body = payload();
      const providers = { ...(body.providers as Record<string, unknown>) };
      delete providers["browser-use"];
      return { ...body, providers };
    },
    "missing cloud budgets": () => {
      const body = payload();
      const budgets = { ...(body.budgets as Record<string, unknown>) };
      delete budgets.maximumCloudBrowserCalls;
      return { ...body, budgets };
    },
    "fractional budget": () => {
      const body = payload();
      return {
        ...body,
        budgets: { ...(body.budgets as object), maximumSearchCalls: 1.5 },
      };
    },
    "negative budget": () => {
      const body = payload();
      return {
        ...body,
        budgets: { ...(body.budgets as object), maximumCloudBrowserCalls: -1 },
      };
    },
    // Independent literals, not the production maximums re-derived: a range the
    // server enforces is part of the contract this boundary reads.
    "browser fallbacks over maximum": () => overBudget("maximumBrowserFallbacks", 51),
    "reader calls over maximum": () => overBudget("maximumManagedReaderCalls", 51),
    "model extractions over maximum": () => overBudget("maximumModelExtractions", 101),
    "search calls over maximum": () => overBudget("maximumSearchCalls", 101),
    "cloud calls over maximum": () => overBudget("maximumCloudBrowserCalls", 21),
    "cloud spend over maximum": () =>
      overBudget("maximumCloudBrowserCostMicros", 100_000_001),
    "unknown root key": () => ({ ...payload(), smuggled: "value" }),
    // The server's own minimum for this one is 1, not 0.
    "zero search calls": () => overBudget("maximumSearchCalls", 0),
    "blank extraction provider": () => ({
      ...payload(),
      extractionModel: { provider: "   ", model: "gpt" },
    }),
    "overlong extraction provider": () => ({
      ...payload(),
      extractionModel: { provider: "p".repeat(161), model: "gpt" },
    }),
    "overlong extraction model": () => ({
      ...payload(),
      extractionModel: { provider: "openai", model: "m".repeat(301) },
    }),
    "malformed optional provider field": () => {
      const body = payload();
      const providers = { ...(body.providers as Record<string, unknown>) };
      providers.exa = { enabled: true, hasApiKey: true, status: "unknown", keyHint: 7 };
      return { ...body, providers };
    },
    "extra key on a provider row": () => {
      const body = payload();
      const providers = { ...(body.providers as Record<string, unknown>) };
      // These rows describe a credential. An unexpected field on one is a
      // payload from somewhere this client should not be reading.
      providers.exa = {
        enabled: true,
        hasApiKey: true,
        status: "unknown",
        apiKey: "leaked-secret",
      };
      return { ...body, providers };
    },
  };

  for (const [label, build] of Object.entries(cases)) {
    await expect(fetchWith(build()), label).rejects.toThrow(
      /could not be read/iu,
    );
  }
});
