import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectTypedSafetyViolations } from "../../core/typed-safety-policy.js";
import { readOwnedTypeSafetySourceFiles } from "../../core/owned-type-safety-source.js";

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "Node16",
    moduleResolution: "Node16",
    lib: ["ES2022", "DOM"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src/**/*.ts"],
});

const FIXTURE_SOURCE = [
  "export async function load(): Promise<number> { return 1 }",
  "export function run(): void {",
  "  load()",
  "  void load()",
  "  load().catch(() => undefined)",
  "  load().then(() => undefined)",
  "  const parsed = JSON.parse('{}')",
  "  const known: unknown = JSON.parse('{}')",
  "  JSON.parse('{}').run()",
  "  const count: number = JSON.parse('1')",
  "  takesNumber(JSON.parse('1'))",
  "  console.log(JSON.parse('1'), parsed, known, count)",
  "}",
  "function takesNumber(value: number): number { return value }",
  "export function read(): string { return JSON.parse('\"x\"') }",
  "export function readUnknown(): unknown { return JSON.parse('\"x\"') }",
  "export const arrow = (): string => JSON.parse('\"x\"')",
  "export async function readAsync(): Promise<string> { return JSON.parse('\"x\"') }",
  "load().then(() => undefined, () => undefined)",
].join("\n");

async function withFixture<T>(
  files: Record<string, string>,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "pipeline-typed-safety-"));
  try {
    await writeFile(path.join(root, "tsconfig.json"), FIXTURE_TSCONFIG);
    for (const [relative, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), source);
    }
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("typed safety policy rejects floating promises and unsafe any flow", async () => {
  await withFixture({ "src/example.ts": FIXTURE_SOURCE }, async (root) => {
    const violations = collectTypedSafetyViolations({
      root,
      tsconfigPaths: ["tsconfig.json"],
      isOwned: () => true,
    });

    assert.deepEqual(violations, [
      { file: "src/example.ts", line: 3, rule: "no-floating-promise" },
      { file: "src/example.ts", line: 6, rule: "no-floating-promise" },
      { file: "src/example.ts", line: 7, rule: "no-unsafe-any-assignment" },
      { file: "src/example.ts", line: 9, rule: "no-unsafe-any-call" },
      { file: "src/example.ts", line: 9, rule: "no-unsafe-any-member-access" },
      { file: "src/example.ts", line: 10, rule: "no-unsafe-any-assignment" },
      { file: "src/example.ts", line: 11, rule: "no-unsafe-any-argument" },
      { file: "src/example.ts", line: 15, rule: "no-unsafe-any-return" },
      { file: "src/example.ts", line: 17, rule: "no-unsafe-any-return" },
      { file: "src/example.ts", line: 18, rule: "no-unsafe-any-return" },
    ]);
  });
});

test("typed safety policy follows any into properties, elements, defaults, and fields", async () => {
  const source = [
    "declare const flag: boolean",
    "export const record: { count: number } = { count: JSON.parse('1') }",
    "export const list: number[] = [JSON.parse('1')]",
    "export function withDefault(count: number = JSON.parse('1')): number { return count }",
    "export class Holder { count: number = JSON.parse('1') }",
    "export const chosen: number = flag ? JSON.parse('1') : 0",
    "export const nested: { inner: { count: number } } = { inner: { count: JSON.parse('1') } }",
    "export const loose: { value: unknown } = { value: JSON.parse('1') }",
    "export const asserted = JSON.parse('1') as number",
  ].join("\n");

  await withFixture({ "src/flows.ts": source }, async (root) => {
    const violations = collectTypedSafetyViolations({
      root,
      tsconfigPaths: ["tsconfig.json"],
      isOwned: () => true,
    });

    assert.deepEqual(violations, [
      { file: "src/flows.ts", line: 2, rule: "no-unsafe-any-assignment" },
      { file: "src/flows.ts", line: 3, rule: "no-unsafe-any-assignment" },
      { file: "src/flows.ts", line: 4, rule: "no-unsafe-any-assignment" },
      { file: "src/flows.ts", line: 5, rule: "no-unsafe-any-assignment" },
      { file: "src/flows.ts", line: 6, rule: "no-unsafe-any-assignment" },
      { file: "src/flows.ts", line: 7, rule: "no-unsafe-any-assignment" },
    ]);
  });
});

test("typed safety policy does not treat a dynamic import as a call on any", async () => {
  const source = [
    "export async function joined(): Promise<string> {",
    "  const helper = await import('./helper.js')",
    "  return helper.join('a', 'b')",
    "}",
  ].join("\n");
  const helper = "export function join(left: string, right: string): string { return `${left}/${right}` }\n";

  await withFixture({ "src/lazy.ts": source, "src/helper.ts": helper }, async (root) => {
    const violations = collectTypedSafetyViolations({
      root,
      tsconfigPaths: ["tsconfig.json"],
      isOwned: () => true,
    });

    assert.deepEqual(violations, []);
  });
});

test("typed safety policy checks only the files it is told are owned", async () => {
  await withFixture(
    {
      "src/owned.ts": "export const owned: unknown = JSON.parse('1')\n",
      "src/generated.ts": "export const generated = JSON.parse('1')\n",
    },
    async (root) => {
      const violations = collectTypedSafetyViolations({
        root,
        tsconfigPaths: ["tsconfig.json"],
        isOwned: (file) => file !== "src/generated.ts",
      });

      assert.deepEqual(violations, []);
    },
  );
});

test("owned backend production source contains no typed safety violations", async () => {
  const root = process.cwd();
  const owned = new Set(
    (await readOwnedTypeSafetySourceFiles(root))
      .map((file) => file.path)
      .filter((file) => !file.startsWith("ui/")),
  );

  const violations = collectTypedSafetyViolations({
    root,
    tsconfigPaths: ["tsconfig.json", "tsconfig.electron.json"],
    isOwned: (file) => owned.has(file),
  });

  assert.deepEqual(violations, []);
});
