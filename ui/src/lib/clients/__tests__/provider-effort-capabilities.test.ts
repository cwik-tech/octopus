import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchProviderCatalog } from "@/lib/clients/provider-settings-client";

/**
 * The effort ranges arriving over HTTP.
 *
 * A new response field crosses this boundary, and the editor decides what to
 * offer from it. An unchecked field would let a malformed or stale server put
 * a level in a menu that nothing in this application can express, so the read
 * is validated here rather than trusted because the type says so.
 */
function stubCatalog(payload: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

const CATALOG = {
  catalog: [],
  defaultModel: null,
  defaultModelState: { status: "unset" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider catalogue effort capabilities", () => {
  it("reads the ranges a well-formed response carries", async () => {
    stubCatalog({
      ...CATALOG,
      effortCapabilities: [
        { provider: "openai", model: "gpt-5.6-sol", levels: ["off", "high"] },
      ],
    });

    const snapshot = await fetchProviderCatalog();

    expect(snapshot.effortCapabilities).toEqual([
      { provider: "openai", model: "gpt-5.6-sol", levels: ["off", "high"] },
    ]);
  });

  it("treats an absent field as no ranges rather than as a broken response", async () => {
    // A desktop build can be newer than the API it is talking to.
    stubCatalog({ ...CATALOG });
    expect((await fetchProviderCatalog()).effortCapabilities).toEqual([]);
  });

  it("refuses a response whose ranges are not shaped like ranges", async () => {
    stubCatalog({ ...CATALOG, effortCapabilities: "all of them" });
    await expect(fetchProviderCatalog()).rejects.toThrow(/ModelEffortCapability/);

    stubCatalog({ ...CATALOG, effortCapabilities: [{ provider: "openai" }] });
    await expect(fetchProviderCatalog()).rejects.toThrow(/ModelEffortCapability/);
  });

  it("drops a level this application cannot express, keeping the rest", async () => {
    // A server that learns a new level before this build does must not put a
    // word in the menu that no adapter can write.
    stubCatalog({
      ...CATALOG,
      effortCapabilities: [
        { provider: "openai", model: "gpt-5.6-sol", levels: ["high", "galactic"] },
      ],
    });

    expect((await fetchProviderCatalog()).effortCapabilities).toEqual([
      { provider: "openai", model: "gpt-5.6-sol", levels: ["high"] },
    ]);
  });
});
