import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ResearchAcquisitionSettings } from "@/components/settings/research-acquisition-settings";
import type { BrowserSettingsSnapshot } from "@/lib/clients/browser-settings-client";
import type { AcquisitionSettingsSnapshot } from "@/lib/clients/acquisition-settings-client";
import type { DeepResearchSettingsSnapshot } from "@/lib/clients/deep-research-settings-client";

const defaultSnapshot: DeepResearchSettingsSnapshot = {
  schemaVersion: 3,
  maxDurationMinutes: 20,
  maxResearcherAgents: 8,
  constraints: {
    maxDurationMinutes: { minimum: 5, maximum: 120 },
    maxResearcherAgents: { minimum: 1, maximum: 8 },
  },
  source: "default",
  editable: true,
};

const browserSnapshot: BrowserSettingsSnapshot = {
  status: "stopped",
  mode: "headless",
  executablePath: "/Applications/Google Chrome.app/Chrome",
  profilePath: "/tmp/pipeline-browser-profile",
  pageCount: 0,
  saved: true,
};

const acquisitionSnapshot: AcquisitionSettingsSnapshot = {
  schemaVersion: 3,
  providerPriority: ["exa", "brave"],
  providers: {
    exa: { enabled: false, hasApiKey: false, status: "unknown" },
    brave: { enabled: false, hasApiKey: false, status: "unknown" },
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
  source: "default",
  editable: true,
};

const webshareSnapshot = {
  settingsSchemaVersion: 2 as const,
  proxyEnabled: false,
  credentialMode: "username-password" as const,
  proxyHost: "p.webshare.io",
  proxyPort: 80,
  countries: ["us"],
  username: "",
  source: "default" as const,
  apiTokenConfigured: false,
  passwordConfigured: false,
  proxyStatus: "unverified" as const,
  geminiApiKeyConfigured: false,
  geminiSource: "default" as const,
  geminiStatus: "unverified" as const,
  geminiModel: "gemini-3.6-flash" as const,
  geminiDailyVideoMinutesLimit: 120,
  geminiConfirmationThresholdMinutes: 30,
  geminiBudgetWindow: "rolling_24_hours" as const,
  deleteVideosAfterInfoExtraction: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("loads defaults and explains both independent ceilings", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    isAcquisitionSettingsRequest(input)
      ? jsonResponse(acquisitionSnapshot)
      : isBrowserSettingsRequest(input)
      ? jsonResponse(browserSnapshot)
      : isWebshareSettingsRequest(input)
      ? jsonResponse(webshareSnapshot)
      : jsonResponse(defaultSnapshot),
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<ResearchAcquisitionSettings />);

  expect(screen.getByText(
    "Loading Deep Research settings...",
  )).toBeInTheDocument();
  const durationInput = await screen.findByLabelText(
    "Maximum research duration",
  );
  const agentsInput = screen.getByLabelText("Maximum researcher agents");
  await waitFor(() => expect(durationInput).toHaveValue(20));
  expect(durationInput).toHaveAttribute("min", "5");
  expect(durationInput).toHaveAttribute("max", "120");
  expect(durationInput).toHaveAttribute("step", "1");
  expect(agentsInput).toHaveValue(8);
  expect(agentsInput).toHaveAttribute("min", "1");
  expect(agentsInput).toHaveAttribute("max", "8");
  expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();
  expect(screen.getByRole("heading", { name: "Search and acquisition" }))
    .toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Managed Chrome" }))
    .toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Webshare residential proxy" }))
    .toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "YouTube video analysis" }))
    .toBeInTheDocument();
  expect(screen.getByTestId("research-acquisition-settings"))
    .toHaveClass("space-y-6");
  expect(screen.getByLabelText("Exa API key")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Dedicated extraction model" }))
    .toBeInTheDocument();
  expect(screen.getByLabelText("Dedicated extraction model"))
    .toBeInTheDocument();
  expect(screen.getByLabelText("Model extractions")).toHaveValue(20);
  expect(screen.getByRole("button", { name: "Headless" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByText(/per-run internal researcher ceiling/)).toHaveTextContent(
    "separate from the workspace's top-level task and workflow capacity",
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings/deep-research",
    undefined,
  );
  expect(fetchMock).toHaveBeenCalledWith("/api/settings/browser", undefined);
});

it("saves and validates a masked Gemini key with rolling-budget controls", async () => {
  const fetchMock = vi.fn(
    async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (isAcquisitionSettingsRequest(request)) return jsonResponse(acquisitionSnapshot);
      if (isBrowserSettingsRequest(request)) return jsonResponse(browserSnapshot);
      if (!isWebshareSettingsRequest(request)) return jsonResponse(defaultSnapshot);
      if (String(request).endsWith("/settings/youtube/gemini/validate")) {
        return jsonResponse({
          ...webshareSnapshot,
          geminiApiKeyConfigured: true,
          geminiSource: "persisted",
          geminiStatus: "connected",
        });
      }
      if (init?.method === "PATCH") {
        return jsonResponse({
          ...webshareSnapshot,
          geminiApiKeyConfigured: true,
          geminiSource: "persisted",
        });
      }
      return jsonResponse(webshareSnapshot);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const keyInput = await screen.findByLabelText("Google AI Studio API key");
  expect(keyInput).toHaveAttribute("type", "password");
  expect(screen.getByText("gemini-3.6-flash")).toBeInTheDocument();
  expect(screen.getByLabelText("Rolling 24-hour video limit")).toHaveValue(120);
  expect(screen.getByLabelText("Long-video confirmation threshold")).toHaveValue(30);

  await user.type(keyInput, "saved-gemini-key");
  await user.click(screen.getByRole("button", { name: "Save and validate" }));

  const validationCall = fetchMock.mock.calls.find(([input, init]) =>
    String(input).endsWith("/settings/youtube/gemini/validate") &&
    typeof init?.body === "string"
  );
  expect(JSON.parse(String(validationCall?.[1]?.body))).toEqual({
    apiKey: "saved-gemini-key",
    model: "gemini-3.6-flash",
  });
  const patchCall = fetchMock.mock.calls.find(([, init]) =>
    init?.method === "PATCH" && String(init.body).includes("saved-gemini-key")
  );
  expect(fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.indexOf(validationCall!)]!)
    .toBeLessThan(fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.indexOf(patchCall!)]!);
  expect(patchCall?.[0]).toBe("/api/settings/youtube");
  expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
    geminiApiKey: "saved-gemini-key",
    geminiModel: "gemini-3.6-flash",
    geminiDailyVideoMinutesLimit: 120,
    geminiConfirmationThresholdMinutes: 30,
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings/youtube/gemini/validate",
    { method: "POST" },
  ));
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(keyInput).toHaveValue("");
});

it("lists API models in the shared guardrail row and explains both confirmation controls", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) return jsonResponse(acquisitionSnapshot);
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (String(input).endsWith("/settings/youtube/gemini/models")) {
      return jsonResponse({
        models: [
          { id: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash" },
          { id: "gemini-3.6-pro", displayName: "Gemini 3.6 Pro" },
        ],
      });
    }
    if (init?.method === "PATCH") {
      const update = JSON.parse(String(init.body)) as { geminiModel: string };
      return jsonResponse({
        ...webshareSnapshot,
        geminiApiKeyConfigured: true,
        geminiSource: "persisted",
        geminiModel: update.geminiModel,
      });
    }
    if (isWebshareSettingsRequest(input)) {
      return jsonResponse({
        ...webshareSnapshot,
        geminiApiKeyConfigured: true,
        geminiSource: "persisted",
      });
    }
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const model = await screen.findByRole("button", { name: "Gemini model" });
  await waitFor(() => expect(model).toHaveTextContent("Gemini 3.6 Flash"));
  await user.click(model);
  const search = await screen.findByPlaceholderText("Search Gemini models...");
  await user.type(search, "3.6 Pro");
  await user.click(screen.getByText("Gemini 3.6 Pro"));
  expect(model).toHaveTextContent("Gemini 3.6 Pro");
  await user.click(screen.getByRole("button", { name: "Save and validate" }));
  await waitFor(() => {
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      geminiModel: "gemini-3.6-pro",
    });
  });
  expect(screen.getByTestId("youtube-gemini-controls")).toHaveClass("lg:grid-cols-3");

  await user.hover(screen.getByRole("button", { name: "About rolling 24-hour video limit" }));
  expect(await screen.findByText(/confirmation guardrail.*not a Google API quota/i))
    .toBeVisible();
  await user.hover(screen.getByRole("button", { name: "About long-video confirmation threshold" }));
  expect(await screen.findByText(/single video.*confirmation/i)).toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/settings/youtube/gemini/models",
    undefined,
  );
  expect(fetchMock.mock.calls.filter(([input]) =>
    String(input).endsWith("/settings/youtube/gemini/models")
  )).toHaveLength(1);
});

it("keeps every Gemini control read-only when GEMINI_API_KEY owns the configuration", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "PATCH"
      ? jsonResponse({
          ...webshareSnapshot,
          geminiApiKeyConfigured: true,
          geminiSource: "environment",
          deleteVideosAfterInfoExtraction: true,
        })
      :
    isAcquisitionSettingsRequest(input)
      ? jsonResponse(acquisitionSnapshot)
      : isBrowserSettingsRequest(input)
      ? jsonResponse(browserSnapshot)
      : isWebshareSettingsRequest(input)
      ? jsonResponse({
          ...webshareSnapshot,
          geminiApiKeyConfigured: true,
          geminiSource: "environment",
        })
      : jsonResponse(defaultSnapshot));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();

  render(<ResearchAcquisitionSettings />);

  expect(await screen.findByLabelText("Google AI Studio API key")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Gemini model" })).toBeDisabled();
  expect(screen.getByLabelText("Rolling 24-hour video limit")).toBeDisabled();
  expect(screen.getByLabelText("Long-video confirmation threshold")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save and validate" })).toBeDisabled();
  const retention = screen.getByRole("switch", { name: "Delete videos after info extraction" });
  expect(retention).not.toBeChecked();
  expect(retention).toBeEnabled();
  await user.click(retention);
  await waitFor(() => expect(retention).toBeChecked());
  const retentionCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(JSON.parse(String(retentionCall?.[1]?.body))).toMatchObject({
    deleteVideosAfterInfoExtraction: true,
  });
  expect(screen.getByText(/GEMINI_API_KEY.*saved model and limits remain active.*read-only/i))
    .toBeInTheDocument();
});

it("toggling the retention switch preserves unsaved Gemini draft edits", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "PATCH"
      ? jsonResponse({ ...webshareSnapshot, deleteVideosAfterInfoExtraction: true })
      :
    isAcquisitionSettingsRequest(input)
      ? jsonResponse(acquisitionSnapshot)
      : isBrowserSettingsRequest(input)
      ? jsonResponse(browserSnapshot)
      : isWebshareSettingsRequest(input)
      ? jsonResponse(webshareSnapshot)
      : jsonResponse(defaultSnapshot));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const apiKey = await screen.findByLabelText("Google AI Studio API key");
  const dailyLimit = screen.getByLabelText("Rolling 24-hour video limit");
  await waitFor(() => expect(dailyLimit).toHaveValue(120));
  await user.type(apiKey, "unsaved-gemini-key");
  await user.clear(dailyLimit);
  await user.type(dailyLimit, "99");

  const retention = screen.getByRole("switch", { name: "Delete videos after info extraction" });
  await user.click(retention);
  await waitFor(() => expect(retention).toBeChecked());

  expect(apiKey).toHaveValue("unsaved-gemini-key");
  expect(dailyLimit).toHaveValue(99);

  await user.click(screen.getByRole("button", { name: "Save and validate" }));
  await waitFor(() => {
    const saveCall = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "PATCH")
      .map(([, init]): unknown => JSON.parse(String(init?.body)))
      .find((body) => isRecord(body) && "geminiApiKey" in body);
    expect(saveCall).toMatchObject({
      geminiApiKey: "unsaved-gemini-key",
      geminiDailyVideoMinutesLimit: 99,
    });
  });
});

it("validates each range and adopts only the successful PATCH response", async () => {
  let resolveSave: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(
    async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (isAcquisitionSettingsRequest(request)) return jsonResponse(acquisitionSnapshot);
      if (isBrowserSettingsRequest(request)) return jsonResponse(browserSnapshot);
      if (isWebshareSettingsRequest(request)) return jsonResponse(webshareSnapshot);
      if (init?.method !== "PATCH") return jsonResponse(defaultSnapshot);
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const durationInput = await screen.findByLabelText(
    "Maximum research duration",
  );
  const agentsInput = screen.getByLabelText("Maximum researcher agents");
  await waitFor(() => expect(durationInput).toHaveValue(20));

  await user.clear(durationInput);
  await user.type(durationInput, "4");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter a whole number between 5 and 120.",
  );
  expect(durationInput).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();

  await user.clear(durationInput);
  await user.type(durationInput, "45");
  await user.clear(agentsInput);
  await user.type(agentsInput, "9");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter a whole number between 1 and 8.",
  );

  await user.clear(agentsInput);
  await user.type(agentsInput, "5");
  expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes.");
  await user.click(screen.getByRole("button", { name: "Save limits" }));

  expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
  expect(durationInput).toBeDisabled();
  expect(agentsInput).toBeDisabled();
  const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patchCall?.[0]).toBe("/api/settings/deep-research");
  expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
    maxDurationMinutes: 45,
    maxResearcherAgents: 5,
  });

  resolveSave?.(
    jsonResponse({
      ...defaultSnapshot,
      maxDurationMinutes: 40,
      maxResearcherAgents: 4,
      source: "persisted",
    }),
  );
  await waitFor(() => expect(durationInput).toHaveValue(40));
  expect(agentsInput).toHaveValue(4);
  expect(screen.getByRole("button", { name: "Headless" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Saved. New research runs will use these ceilings.",
  );
});

it("uses the shared Browser contract for research browser mode", async () => {
  const fetchMock = vi.fn(
    async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (isAcquisitionSettingsRequest(request)) return jsonResponse(acquisitionSnapshot);
      if (isWebshareSettingsRequest(request)) return jsonResponse(webshareSnapshot);
      if (!isBrowserSettingsRequest(request)) return jsonResponse(defaultSnapshot);
      if (init?.method !== "PUT") return jsonResponse(browserSnapshot);
      const body = JSON.parse(String(init.body)) as {
        mode: BrowserSettingsSnapshot["mode"];
      };
      return jsonResponse({ ...browserSnapshot, mode: body.mode });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  await screen.findByLabelText("Maximum research duration");
  expect(screen.getByRole("button", { name: "Headless" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Headed" }));

  const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(putCall?.[0]).toBe("/api/settings/browser");
  expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
    mode: "headed",
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Headed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    ),
  );
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();
});

it("renders a returned read-only snapshot without enabling mutation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      isAcquisitionSettingsRequest(input)
        ? jsonResponse(acquisitionSnapshot)
        : isBrowserSettingsRequest(input)
        ? jsonResponse(browserSnapshot)
        : isWebshareSettingsRequest(input)
        ? jsonResponse(webshareSnapshot)
        : jsonResponse({
            ...defaultSnapshot,
            editable: false,
          } satisfies DeepResearchSettingsSnapshot),
    ),
  );

  render(<ResearchAcquisitionSettings />);

  const durationInput = await screen.findByLabelText(
    "Maximum research duration",
  );
  await waitFor(() => expect(durationInput).toHaveValue(20));
  expect(durationInput).toBeDisabled();
  expect(screen.getByLabelText("Maximum researcher agents")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();
  expect(screen.getByText("These values are read-only in the current runtime."))
    .toBeInTheDocument();
});

it("uses stable error codes and keeps unsaved drafts after persistence failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) =>
      isAcquisitionSettingsRequest(request)
        ? jsonResponse(acquisitionSnapshot)
        : isBrowserSettingsRequest(request)
        ? jsonResponse(browserSnapshot)
        : isWebshareSettingsRequest(request)
        ? jsonResponse(webshareSnapshot)
        : init?.method === "PATCH"
          ? jsonResponse(
              {
                error: "Backend wording that must not drive the interface.",
                code: "settings_persistence_failed",
                retryable: true,
              },
              500,
            )
          : jsonResponse(defaultSnapshot),
    ),
  );
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const durationInput = await screen.findByLabelText(
    "Maximum research duration",
  );
  await waitFor(() => expect(durationInput).toHaveValue(20));
  await user.clear(durationInput);
  await user.type(durationInput, "35");
  await user.click(screen.getByRole("button", { name: "Save limits" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The limits could not be saved. The previous limits remain active.",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("Backend wording");
  expect(durationInput).toHaveValue(35);
  expect(screen.getByRole("button", { name: "Save limits" })).toBeEnabled();
});

it("tests a typed acquisition key by saving it before validating", async () => {
  const savedSnapshot: AcquisitionSettingsSnapshot = {
    ...acquisitionSnapshot,
    providerPriority: ["brave", "exa"],
    providers: {
      ...acquisitionSnapshot.providers,
      brave: { enabled: true, hasApiKey: true, keyHint: "Saved", status: "unknown" },
    },
    source: "persisted",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionValidateRequest(input)) {
      return jsonResponse({
        ...savedSnapshot,
        providers: {
          ...savedSnapshot.providers,
          brave: { enabled: true, hasApiKey: true, keyHint: "Saved", status: "connected" },
        },
      });
    }
    if (isAcquisitionSettingsRequest(input)) {
      return jsonResponse(init?.method === "PATCH" ? savedSnapshot : acquisitionSnapshot);
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const braveKey = await screen.findByLabelText("Brave Search API key");
  const braveTest = within(rowFor("Brave Search API key")).getByRole("button", {
    name: "Test",
  });
  expect(braveTest).toBeDisabled();

  await user.type(braveKey, "brave-key");
  expect(within(rowFor("Brave Search API key")).getByText("Unsaved key")).toBeInTheDocument();
  expect(braveTest).toBeEnabled();

  await user.click(braveTest);

  await waitFor(() =>
    expect(within(rowFor("Brave Search API key")).getByText("Connected")).toBeInTheDocument(),
  );
  const patchCall = fetchMock.mock.calls.find(
    ([input, init]) => isAcquisitionSettingsRequest(input) && init?.method === "PATCH",
  );
  expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
    providers: { brave: { enabled: false, apiKey: "brave-key" } },
  });
  const validateCall = fetchMock.mock.calls.find(([input]) =>
    isAcquisitionValidateRequest(input),
  );
  if (!patchCall || !validateCall) {
    throw new Error("Expected the key save and validation requests.");
  }
  const patchOrder = fetchMock.mock.invocationCallOrder[
    fetchMock.mock.calls.indexOf(patchCall)
  ];
  const validateOrder = fetchMock.mock.invocationCallOrder[
    fetchMock.mock.calls.indexOf(validateCall)
  ];
  if (patchOrder === undefined || validateOrder === undefined) {
    throw new Error("Expected invocation order for the key save and validation requests.");
  }
  expect(JSON.parse(String(validateCall[1]?.body))).toEqual({ provider: "brave" });
  expect(patchOrder).toBeLessThan(validateOrder);
  expect(braveKey).toHaveValue("");
});

it("saves each acquisition field the moment it changes, with no save button", async () => {
  const saved: unknown[] = [];
  const keyedSnapshot: AcquisitionSettingsSnapshot = {
    ...acquisitionSnapshot,
    providers: {
      ...acquisitionSnapshot.providers,
      exa: { enabled: false, hasApiKey: true, keyHint: "Saved", status: "unknown" },
    },
    source: "persisted",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") return jsonResponse(acquisitionSnapshot);
      saved.push(JSON.parse(String(init.body)));
      return jsonResponse(keyedSnapshot);
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const searchCalls = await screen.findByLabelText("Search calls");
  expect(screen.queryByRole("button", { name: "Save acquisition" })).not.toBeInTheDocument();

  await user.clear(searchCalls);
  await user.type(searchCalls, "37");
  await user.tab();
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({ budgets: { maximumSearchCalls: 37 } });

  const exaKey = screen.getByLabelText("Exa API key");
  await user.type(exaKey, "exa-key");
  await user.tab();
  await waitFor(() => expect(saved).toHaveLength(2));
  // The budget saved a moment ago travels with the key: each request carries
  // the whole configuration, so no field is quietly rolled back by the next.
  expect(saved[1]).toMatchObject({
    providers: { exa: { enabled: false, apiKey: "exa-key" } },
    budgets: { maximumSearchCalls: 37 },
  });
  expect(exaKey).toHaveValue("");
  expect(within(rowFor("Exa API key")).getByText("Not checked")).toBeInTheDocument();
  expect(searchCalls).toHaveValue(37);
});

it("will not offer to enable a provider that has no key", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      isAcquisitionSettingsRequest(input)
        ? jsonResponse(acquisitionSnapshot)
        : isBrowserSettingsRequest(input)
        ? jsonResponse(browserSnapshot)
        : isWebshareSettingsRequest(input)
        ? jsonResponse(webshareSnapshot)
        : jsonResponse(defaultSnapshot),
    ),
  );
  render(<ResearchAcquisitionSettings />);

  // Exa ships enabled in the stored defaults, and without a key nothing it is
  // switched on for can run. The row has to say so rather than show a live
  // provider the application ignores.
  const exa = await screen.findByRole("switch", { name: "Enable Exa" });
  expect(exa).not.toBeChecked();
  expect(exa).toHaveAttribute("aria-disabled", "true");
});

it("frees the switch as soon as a typed key is stored", async () => {
  const saved: unknown[] = [];
  const keyless = {
    enabled: false,
    hasApiKey: false,
    status: "unknown" as const,
  };
  const stored = {
    enabled: false,
    hasApiKey: true,
    keyHint: "Saved",
    status: "unknown" as const,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") {
        return jsonResponse({
          ...acquisitionSnapshot,
          providers: { ...acquisitionSnapshot.providers, firecrawl: keyless },
        });
      }
      const body: unknown = JSON.parse(String(init.body));
      saved.push(body);
      return jsonResponse({
        ...acquisitionSnapshot,
        providers: {
          ...acquisitionSnapshot.providers,
          firecrawl: {
            ...stored,
            enabled: saved.length > 1,
          },
        },
        source: "persisted",
      });
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const toggle = await screen.findByRole("switch", { name: "Enable Firecrawl" });
  expect(toggle).toHaveAttribute("aria-disabled", "true");

  await user.type(screen.getByLabelText("Firecrawl API key"), "fc-key");
  await user.tab();
  await waitFor(() => expect(saved).toHaveLength(1));

  // The key the save just stored has to reach the switch. Rendering the switch
  // from a snapshot the response has already replaced would leave the row
  // holding a working key and no way to turn it on.
  const live = await screen.findByRole("switch", { name: "Enable Firecrawl" });
  await waitFor(() => expect(live).not.toHaveAttribute("aria-disabled", "true"));

  await user.click(live);
  await waitFor(() => expect(saved).toHaveLength(2));
  expect(saved[1]).toMatchObject({ providers: { firecrawl: { enabled: true } } });
  expect(await screen.findByRole("switch", { name: "Enable Firecrawl" })).toBeChecked();
});

it("keeps saving other fields while a budget is mid-edit", async () => {
  const saved: unknown[] = [];
  const stored = {
    enabled: false,
    hasApiKey: true,
    keyHint: "Saved",
    status: "connected" as const,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") {
        return jsonResponse({
          ...acquisitionSnapshot,
          providers: { ...acquisitionSnapshot.providers, "browser-use": stored },
          source: "persisted",
        });
      }
      saved.push(JSON.parse(String(init.body)));
      return jsonResponse({
        ...acquisitionSnapshot,
        providers: {
          ...acquisitionSnapshot.providers,
          "browser-use": { ...stored, enabled: true },
        },
        source: "persisted",
      });
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  // An emptied number field is not a number yet. Dropping the whole request
  // over it would lose the switch the user flips next, which is the exact
  // failure this screen was rebuilt to end.
  const searchCalls = await screen.findByLabelText("Search calls");
  await user.clear(searchCalls);
  expect(searchCalls).toHaveAttribute("aria-invalid", "true");

  await user.click(screen.getByRole("switch", { name: "Enable Browser Use" }));

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({
    providers: { "browser-use": { enabled: true } },
    // The stored ceiling travels untouched; the blank field sends nothing.
    budgets: { maximumSearchCalls: 20 },
  });
});

it("stores a key once when Enter is followed by leaving the field", async () => {
  const saved: ProvidersPatch[] = [];
  const keyed: AcquisitionSettingsSnapshot = {
    ...acquisitionSnapshot,
    providers: {
      ...acquisitionSnapshot.providers,
      firecrawl: { enabled: false, hasApiKey: true, keyHint: "Saved", status: "unknown" },
    },
    source: "persisted",
  };
  // The first save is held open, because that is the only window in which the
  // duplicate can happen: the field still holds the text it is about to be
  // cleared of, so the blur sees a key that looks unsaved.
  let releaseFirstSave: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") return jsonResponse(acquisitionSnapshot);
      saved.push(parseProvidersPatch(init.body));
      if (saved.length > 1) return jsonResponse(keyed);
      return new Promise<Response>((resolve) => {
        releaseFirstSave = resolve;
      });
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const key = await screen.findByLabelText("Firecrawl API key");
  await user.type(key, "fc-key{Enter}");
  await waitFor(() => expect(saved).toHaveLength(1));
  await user.tab();

  releaseFirstSave?.(jsonResponse(keyed));
  await waitFor(() => expect(key).toHaveValue(""));

  // Writes are chained, so a duplicate the blur queued sits ahead of anything
  // clicked afterwards. Waiting for a later write is what makes the count
  // trustworthy rather than a race against a request still in flight.
  const toggle = await screen.findByRole("switch", { name: "Enable Firecrawl" });
  await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"));
  await user.click(toggle);
  await waitFor(() =>
    expect(saved.some((body) => body.providers.firecrawl?.enabled)).toBe(true),
  );

  expect(saved.map((body) => body.providers.firecrawl)).toEqual([
    { enabled: false, apiKey: "fc-key" },
    { enabled: true },
  ]);
});

it("keeps a key retyped while the previous save was in flight", async () => {
  const keyed: AcquisitionSettingsSnapshot = {
    ...acquisitionSnapshot,
    providers: {
      ...acquisitionSnapshot.providers,
      firecrawl: { enabled: false, hasApiKey: true, keyHint: "Saved", status: "unknown" },
    },
    source: "persisted",
  };
  let patches = 0;
  let releaseFirstSave: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") return jsonResponse(acquisitionSnapshot);
      patches += 1;
      if (patches > 1) return jsonResponse(keyed);
      return new Promise<Response>((resolve) => {
        releaseFirstSave = resolve;
      });
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const key = await screen.findByLabelText("Firecrawl API key");
  await user.type(key, "fc-first{Enter}");
  await waitFor(() => expect(patches).toBe(1));

  // The correction is typed while the first key is still on its way. Clearing
  // the field when that older request answers would throw the correction away
  // in front of the user.
  await user.clear(key);
  await user.type(key, "fc-second");
  releaseFirstSave?.(jsonResponse(keyed));

  const toggle = await screen.findByRole("switch", { name: "Enable Firecrawl" });
  await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"));
  expect(key).toHaveValue("fc-second");
});

it("lets a key save that failed be retried by leaving the field", async () => {
  const saved: ProvidersPatch[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") return jsonResponse(acquisitionSnapshot);
      saved.push(parseProvidersPatch(init.body));
      return jsonResponse({ error: "Acquisition settings could not be stored." }, 500);
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const key = await screen.findByLabelText("Firecrawl API key");
  await user.type(key, "fc-key{Enter}");
  await screen.findByText("Acquisition settings could not be stored.");

  // The field still holds the key the failed save was carrying, so leaving it
  // is the obvious way to try again. A guard against duplicate writes must not
  // turn into a guard against retrying.
  await user.tab();

  await waitFor(() => expect(saved).toHaveLength(2));
  expect(saved.map((body) => body.providers.firecrawl?.apiKey)).toEqual([
    "fc-key",
    "fc-key",
  ]);
});

it("does not test a typed key when storing it failed", async () => {
  let validationCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionValidateRequest(input)) {
      validationCalls += 1;
      return jsonResponse(acquisitionSnapshot);
    }
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") return jsonResponse(acquisitionSnapshot);
      return jsonResponse({ error: "Acquisition settings could not be stored." }, 500);
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const key = await screen.findByLabelText("Firecrawl API key");
  await user.type(key, "fc-key");
  const testButton = within(rowFor("Firecrawl API key")).getByRole("button", {
    name: "Test",
  });
  await user.click(testButton);

  await screen.findByText("Acquisition settings could not be stored.");
  await waitFor(() => expect(testButton).toBeEnabled());
  expect(validationCalls).toBe(0);
});

it("clears an earlier failure once a later queued save succeeds", async () => {
  const stored = {
    enabled: false,
    hasApiKey: true,
    keyHint: "Saved",
    status: "connected" as const,
  };
  let patches = 0;
  let failFirstSave: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") {
        return jsonResponse({
          ...acquisitionSnapshot,
          providers: { ...acquisitionSnapshot.providers, "browser-use": stored },
          source: "persisted",
        });
      }
      patches += 1;
      if (patches > 1) {
        return jsonResponse({
          ...acquisitionSnapshot,
          providers: {
            ...acquisitionSnapshot.providers,
            "browser-use": { ...stored, enabled: true },
          },
          source: "persisted",
        });
      }
      return new Promise<Response>((resolve) => {
        failFirstSave = resolve;
      });
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const searchCalls = await screen.findByLabelText("Search calls");
  await user.clear(searchCalls);
  await user.type(searchCalls, "37");
  await user.tab();
  await waitFor(() => expect(patches).toBe(1));

  // Queued behind the save that is about to fail, so it clears the message
  // before that failure is even reported.
  await user.click(screen.getByRole("switch", { name: "Enable Browser Use" }));
  failFirstSave?.(jsonResponse({ error: "Search calls could not be stored." }, 500));

  // The message the failure raises is only cleared by the save that follows
  // it. Clearing at enqueue time cannot do it: the second save had already run
  // that line before the first one failed.
  await waitFor(() => expect(patches).toBe(2));
  expect(await screen.findByText("Acquisition settings saved.")).toBeInTheDocument();
  expect(
    screen.queryByText("Search calls could not be stored."),
  ).not.toBeInTheDocument();
});

it("turns a provider on the moment its switch is flipped", async () => {
  const saved: unknown[] = [];
  const storedKey = {
    hasApiKey: true,
    keyHint: "Saved",
    status: "connected" as const,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") {
        return jsonResponse({
          ...acquisitionSnapshot,
          providers: {
            ...acquisitionSnapshot.providers,
            "browser-use": { enabled: false, ...storedKey },
          },
          source: "persisted",
        });
      }
      saved.push(JSON.parse(String(init.body)));
      return jsonResponse({
        ...acquisitionSnapshot,
        providers: {
          ...acquisitionSnapshot.providers,
          "browser-use": { enabled: true, ...storedKey },
        },
        source: "persisted",
      });
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const toggle = await screen.findByRole("switch", { name: "Enable Browser Use" });
  expect(toggle).not.toBeChecked();

  await user.click(toggle);

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({
    providers: { "browser-use": { enabled: true } },
  });
  expect(toggle).toBeChecked();
});

it("locks acquisition drafts while a key test is in flight", async () => {
  const savedSnapshot: AcquisitionSettingsSnapshot = {
    ...acquisitionSnapshot,
    providerPriority: ["brave", "exa"],
    providers: {
      ...acquisitionSnapshot.providers,
      brave: { enabled: true, hasApiKey: true, keyHint: "Saved", status: "unknown" },
    },
    source: "persisted",
  };
  let resolveKeySave: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionValidateRequest(input)) {
      return jsonResponse({
        ...savedSnapshot,
        providers: {
          ...savedSnapshot.providers,
          brave: { enabled: true, hasApiKey: true, keyHint: "Saved", status: "connected" },
        },
      });
    }
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          resolveKeySave = resolve;
        });
      }
      return jsonResponse(acquisitionSnapshot);
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const braveKey = await screen.findByLabelText("Brave Search API key");
  const searchCalls = screen.getByLabelText("Search calls");
  await user.type(braveKey, "brave-key");
  await user.click(
    within(rowFor("Brave Search API key")).getByRole("button", { name: "Test" }),
  );

  expect(braveKey).toBeDisabled();
  expect(searchCalls).toBeDisabled();

  resolveKeySave?.(jsonResponse(savedSnapshot));
  await waitFor(() =>
    expect(within(rowFor("Brave Search API key")).getByText("Connected")).toBeInTheDocument(),
  );
  expect(searchCalls).toBeEnabled();
});

it("gives the primary slot to the only search provider that has a key", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    isAcquisitionSettingsRequest(input)
      ? jsonResponse(
          init?.method === "PATCH"
            ? {
                ...acquisitionSnapshot,
                providerPriority: ["brave", "exa"],
                providers: {
                  ...acquisitionSnapshot.providers,
                  brave: {
                    enabled: true,
                    hasApiKey: true,
                    keyHint: "Saved",
                    status: "unknown",
                  },
                },
                source: "persisted",
              }
            : acquisitionSnapshot,
        )
      : isBrowserSettingsRequest(input)
      ? jsonResponse(browserSnapshot)
      : isWebshareSettingsRequest(input)
      ? jsonResponse(webshareSnapshot)
      : jsonResponse(defaultSnapshot),
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const primary = await screen.findByLabelText("Primary search provider");
  expect(primary).toHaveTextContent("Exa");
  expect(primary).toBeEnabled();

  await user.type(screen.getByLabelText("Brave Search API key"), "brave-key");
  expect(primary).toHaveTextContent("Brave Search");
  expect(primary).toBeDisabled();

  await user.tab();
  await waitFor(() => {
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => isAcquisitionSettingsRequest(input) && init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      providerPriority: ["brave", "exa"],
    });
  });

  await waitFor(() => expect(primary).toHaveTextContent("Brave Search"));
  await user.type(screen.getByLabelText("Exa API key"), "exa-key");
  expect(primary).toBeEnabled();
});

it("keeps the sole keyed provider primary when the second search key is stored", async () => {
  const saved: unknown[] = [];
  const braveKeyed: AcquisitionSettingsSnapshot = {
    ...acquisitionSnapshot,
    providerPriority: ["brave", "exa"],
    providers: {
      ...acquisitionSnapshot.providers,
      brave: {
        enabled: false,
        hasApiKey: true,
        keyHint: "Saved",
        status: "unknown",
      },
    },
    source: "persisted",
  };
  const bothKeyed: AcquisitionSettingsSnapshot = {
    ...braveKeyed,
    providers: {
      ...braveKeyed.providers,
      exa: {
        enabled: false,
        hasApiKey: true,
        keyHint: "Saved",
        status: "unknown",
      },
    },
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isAcquisitionSettingsRequest(input)) {
      if (init?.method !== "PATCH") return jsonResponse(acquisitionSnapshot);
      saved.push(JSON.parse(String(init.body)));
      return jsonResponse(saved.length === 1 ? braveKeyed : bothKeyed);
    }
    if (isBrowserSettingsRequest(input)) return jsonResponse(browserSnapshot);
    if (isWebshareSettingsRequest(input)) return jsonResponse(webshareSnapshot);
    return jsonResponse(defaultSnapshot);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  const primary = await screen.findByLabelText("Primary search provider");
  await user.type(screen.getByLabelText("Brave Search API key"), "brave-key");
  await user.tab();
  await waitFor(() => expect(saved).toHaveLength(1));
  await waitFor(() => expect(primary).toHaveTextContent("Brave Search"));

  await user.type(screen.getByLabelText("Exa API key"), "exa-key");
  await user.tab();
  await waitFor(() => expect(saved).toHaveLength(2));

  expect(saved[1]).toMatchObject({ providerPriority: ["brave", "exa"] });
  expect(primary).toHaveTextContent("Brave Search");
});

it("moves both acquisition descriptions behind info tooltips", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      isAcquisitionSettingsRequest(input)
        ? jsonResponse(acquisitionSnapshot)
        : isBrowserSettingsRequest(input)
        ? jsonResponse(browserSnapshot)
        : isWebshareSettingsRequest(input)
        ? jsonResponse(webshareSnapshot)
        : jsonResponse(defaultSnapshot),
    ),
  );
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  await screen.findByLabelText("Exa API key");
  expect(screen.queryByText(/Search snippets are never accepted as evidence/))
    .not.toBeInTheDocument();
  expect(screen.queryByText(/Deterministic extraction remains available/))
    .not.toBeInTheDocument();
  expect(screen.queryByText("Optional metered semantic discovery")).not.toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Provider" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "API key" })).toBeInTheDocument();

  await user.hover(screen.getByRole("button", { name: "About search and acquisition" }));
  expect(await screen.findByText(/Search snippets are never accepted as evidence/))
    .toBeVisible();

  await user.hover(
    screen.getByRole("button", { name: "About dedicated extraction model" }),
  );
  expect(await screen.findByText(/Deterministic extraction remains available/))
    .toBeVisible();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isBrowserSettingsRequest(input: RequestInfo | URL): boolean {
  return String(input).endsWith("/settings/browser");
}

function isAcquisitionSettingsRequest(input: RequestInfo | URL): boolean {
  return String(input).includes("/settings/research-acquisition");
}

function isWebshareSettingsRequest(input: RequestInfo | URL): boolean {
  return String(input).includes("/settings/youtube");
}

function isAcquisitionValidateRequest(input: RequestInfo | URL): boolean {
  return String(input).endsWith("/settings/research-acquisition/validate");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ProviderPatch {
  enabled?: boolean;
  apiKey?: string;
}

interface ProvidersPatch {
  providers: Record<string, ProviderPatch>;
}

function isProviderPatch(value: unknown): value is ProviderPatch {
  return (
    isRecord(value) &&
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.apiKey === undefined || typeof value.apiKey === "string")
  );
}

function isProvidersPatch(value: unknown): value is ProvidersPatch {
  return (
    isRecord(value) &&
    isRecord(value.providers) &&
    Object.values(value.providers).every(isProviderPatch)
  );
}

/** A PATCH body that changes providers, checked rather than assumed. */
function parseProvidersPatch(body: BodyInit | null | undefined): ProvidersPatch {
  const parsed: unknown = JSON.parse(String(body));
  if (!isProvidersPatch(parsed)) {
    throw new Error(`Expected a providers patch, got ${String(body)}`);
  }
  return parsed;
}

function rowFor(keyLabel: string): HTMLElement {
  const row = screen.getByLabelText(keyLabel).closest("tr");
  if (!row) throw new Error(`No provider row for ${keyLabel}.`);
  return row;
}

it("sends the cloud browser provider and its spend limits when saved", async () => {
  const saved: unknown[] = [];
  const fetchMock = vi.fn(
    async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (isAcquisitionSettingsRequest(request)) {
        if (init?.method === "PUT" || init?.method === "PATCH" || init?.method === "POST") {
          saved.push(JSON.parse(String(init.body)));
          return jsonResponse(acquisitionSnapshot);
        }
        return jsonResponse(acquisitionSnapshot);
      }
      if (isBrowserSettingsRequest(request)) return jsonResponse(browserSnapshot);
      if (!isWebshareSettingsRequest(request)) return jsonResponse(defaultSnapshot);
      return jsonResponse(webshareSnapshot);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<ResearchAcquisitionSettings />);

  // The paid rung ships off. Raising its call budget is the deliberate act that
  // turns it on, so the value the user types has to reach the API unchanged.
  const callBudget = await screen.findByLabelText("Cloud browser calls");
  await user.clear(callBudget);
  await user.type(callBudget, "3");
  const spendLimit = await screen.findByLabelText("Cloud browser spend threshold");
  await user.clear(spendLimit);
  await user.type(spendLimit, "50000");
  await user.tab();

  await waitFor(() => expect(saved.length).toBeGreaterThan(0));
  const body = saved.at(-1) as {
    providers: Record<string, { enabled: boolean }>;
    budgets: Record<string, number>;
  };
  expect(body.providers["browser-use"]).toEqual({ enabled: false });
  expect(body.budgets.maximumCloudBrowserCalls).toBe(3);
  expect(body.budgets.maximumCloudBrowserCostMicros).toBe(50000);
});
