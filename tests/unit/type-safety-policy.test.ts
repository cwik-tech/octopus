import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectTypeSafetyViolations,
  type TypeSafetyPolicyFile,
} from "../../core/type-safety-policy.js";
import { readOwnedTypeSafetySourceFiles } from "../../core/owned-type-safety-source.js";

test("type-safety policy rejects explicit any and double assertions in owned source", () => {
  const files: TypeSafetyPolicyFile[] = [
    {
      path: "domains/example.ts",
      source: [
        "const unsafeValue: any = value",
        "const forced = value as unknown as string",
      ].join("\n"),
    },
  ];

  const violations = collectTypeSafetyViolations(files);

  assert.deepEqual(violations, [
    {
      file: "domains/example.ts",
      line: 1,
      rule: "no-explicit-any",
    },
    {
      file: "domains/example.ts",
      line: 2,
      rule: "no-double-assertion",
    },
  ]);
});

test("type-safety policy detects AST-level unsafe syntax without matching comments or strings", () => {
  const files: TypeSafetyPolicyFile[] = [
    {
      path: "domains/example.ts",
      source: [
        "type UnsafeAlias = any",
        "const forced = value as string as number",
        "const documentation = 'type Example = any'",
        "// const ignored: any = value",
      ].join("\n"),
    },
  ];

  assert.deepEqual(collectTypeSafetyViolations(files), [
    {
      file: "domains/example.ts",
      line: 1,
      rule: "no-explicit-any",
    },
    {
      file: "domains/example.ts",
      line: 2,
      rule: "no-double-assertion",
    },
  ]);
});

test("type-safety policy rejects non-null assertions but not negation or inequality", () => {
  const files: TypeSafetyPolicyFile[] = [
    {
      path: "domains/example.ts",
      source: [
        "const first = items[0]!",
        "const name = record.owner!.name",
        "const absent = !flag",
        "const differs = left !== right",
        "const note = 'value!'",
      ].join("\n"),
    },
  ];

  assert.deepEqual(collectTypeSafetyViolations(files), [
    {
      file: "domains/example.ts",
      line: 1,
      rule: "no-non-null-assertion",
    },
    {
      file: "domains/example.ts",
      line: 2,
      rule: "no-non-null-assertion",
    },
  ]);
});

test("type-safety policy permits unknown plus a narrowing guard", () => {
  const files: TypeSafetyPolicyFile[] = [
    {
      path: "domains/example.ts",
      source: [
        "const value: unknown = JSON.parse(text)",
        "if (typeof value !== 'string') throw new Error('invalid')",
      ].join("\n"),
    },
  ];

  assert.deepEqual(collectTypeSafetyViolations(files), []);
});

test("owned production source contains no type-safety policy violations", async () => {
  const violations = collectTypeSafetyViolations(
    await readOwnedTypeSafetySourceFiles(process.cwd()),
  );

  assert.deepEqual(violations, []);
});

test("owned-source discovery includes executable scripts and CommonJS TypeScript", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pipeline-type-safety-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "electron"));
    await writeFile(path.join(root, "scripts", "unsafe.ts"), "type Unsafe = any\n");
    await writeFile(path.join(root, "electron", "unsafe.cts"), "const forced = value as string as number\n");
    await writeFile(path.join(root, "vite.config.ts"), "const configuration: any = {}\n");

    const violations = collectTypeSafetyViolations(
      await readOwnedTypeSafetySourceFiles(root),
    );

    assert.deepEqual(violations, [
      { file: "electron/unsafe.cts", line: 1, rule: "no-double-assertion" },
      { file: "scripts/unsafe.ts", line: 1, rule: "no-explicit-any" },
      { file: "vite.config.ts", line: 1, rule: "no-explicit-any" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned-source discovery ignores generated release and test result directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pipeline-type-safety-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "release"));
    await mkdir(path.join(root, "test-results"));
    await writeFile(path.join(root, "scripts", "safe.ts"), "export const safe = true\n");
    await writeFile(path.join(root, "release", "unsafe.ts"), "type Unsafe = any\n");
    await writeFile(path.join(root, "test-results", "unsafe.ts"), "type Unsafe = any\n");

    const sourceFiles = await readOwnedTypeSafetySourceFiles(root);

    assert.deepEqual(
      sourceFiles.map((file) => file.path).sort(),
      ["scripts/safe.ts"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
