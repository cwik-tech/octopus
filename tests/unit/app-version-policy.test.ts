import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAppVersionPolicy,
  incrementPatchVersion,
} from "../../core/app-version-policy.js";

test("an app change requires a version greater than the base version", () => {
  assert.deepEqual(
    evaluateAppVersionPolicy({
      baseVersion: "0.1.0",
      currentVersion: "0.1.0",
      lockfileVersion: "0.1.0",
      rootPackageVersion: "0.1.0",
      changedPaths: ["electron/main.ts"],
    }),
    {
      ok: false,
      message: "App version must increase above 0.1.0 for app-affecting changes.",
    },
  );
});

test("patch bump increments only the patch component", () => {
  assert.deepEqual(incrementPatchVersion("2.7.9"), {
    ok: true,
    version: "2.7.10",
  });
});

test("documentation and test-only changes do not require an app version bump", () => {
  assert.deepEqual(
    evaluateAppVersionPolicy({
      baseVersion: "0.1.0",
      currentVersion: "0.1.0",
      lockfileVersion: "0.1.0",
      rootPackageVersion: "0.1.0",
      changedPaths: [
        "docs/versioning.md",
        "tests/unit/example.test.ts",
        "ui/src/components/__tests__/example.test.tsx",
        "CHANGELOG.md",
      ],
    }),
    {
      ok: true,
      message: "No app-affecting changes require a version bump.",
    },
  );
});

test("an app change accepts a version greater than the base version", () => {
  assert.deepEqual(
    evaluateAppVersionPolicy({
      baseVersion: "0.1.9",
      currentVersion: "0.2.0",
      lockfileVersion: "0.2.0",
      rootPackageVersion: "0.2.0",
      changedPaths: ["ui/src/App.tsx"],
    }),
    {
      ok: true,
      message: "App version increased from 0.1.9 to 0.2.0.",
    },
  );
});

test("an app change rejects a version lower than the base version", () => {
  assert.deepEqual(
    evaluateAppVersionPolicy({
      baseVersion: "1.0.0",
      currentVersion: "0.9.9",
      lockfileVersion: "0.9.9",
      rootPackageVersion: "0.9.9",
      changedPaths: ["agents/example/example.md"],
    }),
    {
      ok: false,
      message: "App version must increase above 1.0.0 for app-affecting changes.",
    },
  );
});

test("a manifest and lockfile version mismatch always fails", () => {
  assert.deepEqual(
    evaluateAppVersionPolicy({
      baseVersion: "0.1.0",
      currentVersion: "0.1.1",
      lockfileVersion: "0.1.0",
      rootPackageVersion: "0.1.1",
      changedPaths: ["docs/versioning.md"],
    }),
    {
      ok: false,
      message: "package.json and package-lock.json must all use version 0.1.1.",
    },
  );
});
