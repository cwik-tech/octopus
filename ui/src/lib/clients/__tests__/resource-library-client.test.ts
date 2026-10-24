import { afterEach, expect, it, vi } from "vitest";
import { getResourceLibrarySnapshot, readResourceLibraryRevisionFiles } from "@/lib/clients/resource-library-client";

afterEach(() => vi.unstubAllGlobals());

it("rejects a malformed Library snapshot at the HTTP boundary", async () => {
  // The local API is replaced only at HTTP to supply a malformed response.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ skills: "invalid" }))));
  await expect(getResourceLibrarySnapshot()).rejects.toThrow();
});

it("rejects malformed revision file metadata before the editor consumes it", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ files: [{ path: "SKILL.md", contentBase64: 42 }] }))));
  await expect(readResourceLibraryRevisionFiles({ skillId: "skill", revisionId: "revision" })).rejects.toThrow();
});
