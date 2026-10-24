import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  setDeleteConfirmationSkipped,
  shouldConfirmDelete,
} from "@/lib/utils/delete-confirmation";

let storage: Record<string, string>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    removeItem: (key: string) => {
      delete storage[key];
    },
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("keeps session deletion confirmation enabled by default", () => {
  expect(shouldConfirmDelete("run-session")).toBe(true);
});

test("persists a session-only confirmation skip preference", () => {
  setDeleteConfirmationSkipped("run-session", true);
  expect(shouldConfirmDelete("run-session")).toBe(false);

  setDeleteConfirmationSkipped("run-session", false);
  expect(shouldConfirmDelete("run-session")).toBe(true);
});
