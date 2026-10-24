import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as z from 'zod/v4';
import { parseYaml, type YamlValue } from '../../core/yaml-parser.js';
import { portableIdSchema } from '../../contracts/resource-package.js';
import type { ResourceSkillFile, ResourceSkillFiles } from './skill-files.js';

export function isPrivateResourcePath(name: string): boolean {
  return name.split('/').some((part) => /^(?:\.env(?:\..*)?|\.git|\.octopus-import-owner|experience|memory|memories|scratch|scratchpads|sessions|logs|credentials|secrets|node_modules)$/i.test(part) || /\.(?:log|sqlite|db)$/i.test(part));
}
export async function readPortableResourceTree(root: string): Promise<ResourceSkillFiles> {
  const files = new Map<string, ResourceSkillFile>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Portable root must be a real directory: ${root}`);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (isPrivateResourcePath(relative) || (!prefix && entry.name === 'skills') || entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Portable resources cannot contain links: ${relative}`);
      if (entry.isDirectory()) { await walk(absolute, `${relative}/`); continue; }
      if (!entry.isFile()) throw new Error(`Unsupported portable resource: ${relative}`);
      const mode = (await fs.stat(absolute)).mode & 0o777;
      files.set(relative, { contents: await fs.readFile(absolute), mode, executable: (mode & 0o111) !== 0 });
    }
  };
  await walk(root, ''); return files;
}
const teamSchema = z.object({
  team: z.object({ name: z.string() }).passthrough(),
  agents: z.array(z.object({ name: portableIdSchema, type: z.enum(['agent', 'team']).default('agent'), agent_file: z.string().optional(), team_path: z.string().optional() }).passthrough()).default([]),
}).passthrough();
export function portableTeam(source: string) { return teamSchema.parse(parseYaml(source)); }

/** Preserve original YAML bytes unless a reviewed identity collision requires remapping. */
export function remapPortableTeam(source: string, agentNames: ReadonlyMap<string, string>, teamNames: ReadonlyMap<string, string>): string {
  portableTeam(source);
  if ([...agentNames, ...teamNames].every(([before, after]) => before === after)) return source;
  const replace = (value: YamlValue): YamlValue => {
    if (Array.isArray(value)) return value.map(replace);
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    if (typeof value !== 'string') return value;
    if (agentNames.has(value)) return agentNames.get(value) ?? value;
    if (teamNames.has(value)) return teamNames.get(value) ?? value;
    let next = value;
    for (const [before, after] of agentNames) next = next.replace(`../../agents/${before}/${before}.md`, `../../agents/${after}/${after}.md`);
    for (const [before, after] of teamNames) next = next === `../${before}` ? `../${after}` : next.replace(`../${before}/team.yaml`, `../${after}/team.yaml`);
    return next;
  };
  return `${renderYaml(replace(parseYaml(source)), 0)}\n`;
}
export function renderYaml(value: YamlValue, depth: number): string {
  const indent = ' '.repeat(depth);
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === 'object' && item !== null ? `${indent}- ${renderYaml(item, depth + 2).slice(depth + 2)}` : `${indent}- ${scalar(item)}`).join('\n') : `${indent}[]`;
  if (typeof value === 'object' && value !== null) return Object.entries(value).map(([key, item]) => {
    const name = /^[a-zA-Z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
    return typeof item === 'object' && item !== null && !(Array.isArray(item) && item.length === 0)
      ? `${indent}${name}:\n${renderYaml(item, depth + 2)}` : `${indent}${name}: ${Array.isArray(item) ? '[]' : scalar(item)}`;
  }).join('\n');
  return `${indent}${scalar(value)}`;
}
function scalar(value: YamlValue): string {
  if (typeof value === 'object' && value !== null) throw new Error('Expected YAML scalar');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite YAML number');
  return JSON.stringify(value);
}
