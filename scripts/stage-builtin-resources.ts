import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { builtInSelectionSchema } from '../contracts/builtin-resources.js';
import { stageCuratedBuiltIns } from '../electron/builtin-resources.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(sourceRoot, 'build', 'curated-resources');
const selectionValue: unknown = JSON.parse(await fs.readFile(path.join(sourceRoot, 'resources/builtins.json'), 'utf8'));
const packageValue: unknown = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
const selection = builtInSelectionSchema.parse(selectionValue);
const { version } = z.object({ version: z.string() }).parse(packageValue);
// This fixed build path contains generated distribution files only; source resources are never changed.
await fs.rm(outputRoot, { recursive: true, force: true });
await stageCuratedBuiltIns({ sourceRoot, outputRoot, appVersion: version, selection });
process.stdout.write(`Curated built-ins staged in ${path.relative(sourceRoot, outputRoot)}\n`);
