import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as z from 'zod/v4'
import { whenDefined } from '../core/optional-properties.js'
import { errorCodeOf } from '../core/node-errors.js'
import { THINKING_LEVELS } from '../contracts/thinking-levels.js'
import type { LocalCliAgentView } from '../domains/provider/provider-settings.js'

const modelSchema = z.object({
  id: z.string(), name: z.string(),
  contextLength: z.number().positive().optional(), free: z.boolean().optional(),
  icon: z.string().optional(), capabilities: z.array(z.enum(['chat', 'pdf'])).optional(),
  supportedEfforts: z.array(z.enum(THINKING_LEVELS)).optional(),
  defaultEffort: z.enum(THINKING_LEVELS).optional(),
}).transform(model => ({
  id: model.id, name: model.name, enabled: false,
  ...whenDefined(model.contextLength, contextLength => ({ contextLength })),
  ...whenDefined(model.free, free => ({ free })),
  ...whenDefined(model.icon, icon => ({ icon })),
  ...whenDefined(model.capabilities, capabilities => ({ capabilities })),
  ...whenDefined(model.supportedEfforts, supportedEfforts => ({ supportedEfforts })),
  ...whenDefined(model.defaultEffort, defaultEffort => ({ defaultEffort })),
}))

// Only display metadata crosses launches. Preferences and MCP readiness remain
// owned by their authoritative settings and fresh runtime probes.
const cacheSchema = z.object({
  version: z.literal(1),
  agents: z.array(z.object({
    id: z.string(), path: z.string().optional(), version: z.string().optional(),
    models: z.array(modelSchema),
  })),
})

export async function readCliDiscoveryCache(storagePath: string | undefined) {
  if (!storagePath) return []
  try {
    const value: unknown = JSON.parse(await fs.readFile(`${storagePath}.cli-cache.json`, 'utf8'))
    const parsed = cacheSchema.safeParse(value)
    return parsed.success ? parsed.data.agents : []
  } catch (error) {
    // This disposable optimization must not prevent access to real settings.
    if (error instanceof SyntaxError || errorCodeOf(error) !== undefined) return []
    throw error
  }
}

export async function writeCliDiscoveryCache(storagePath: string | undefined, agents: readonly LocalCliAgentView[]): Promise<void> {
  if (!storagePath) return
  const cachePath = `${storagePath}.cli-cache.json`
  const metadata = cacheSchema.parse({ version: 1, agents })
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(`${cachePath}.tmp`, JSON.stringify(metadata), { mode: 0o600 })
    await fs.rename(`${cachePath}.tmp`, cachePath)
  } catch (error) {
    if (errorCodeOf(error) === undefined) throw error
    // Live discovery remains usable even if this optional disk cache cannot save.
    console.error(JSON.stringify({ event: 'cli_discovery_cache_write_failed', code: errorCodeOf(error) }))
  }
}
