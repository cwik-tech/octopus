import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import { BrowserManager, type BrowserMode, type BrowserStatusSnapshot } from '../domains/browser/browser-manager.js'

export interface BrowserSettingsSnapshot extends BrowserStatusSnapshot {
  readonly saved: true
}

export class BrowserSettingsService {
  private hydration?: Promise<void>

  constructor(
    private readonly manager: BrowserManager,
    private readonly storagePath: string,
  ) {}

  async snapshot(): Promise<BrowserSettingsSnapshot> {
    await this.hydrateRuntime()
    return { ...(await this.manager.status()), saved: true }
  }

  async hydrateRuntime(): Promise<void> {
    this.hydration ??= this.hydratePersistedRuntime()
    await this.hydration
  }

  async setMode(mode: BrowserMode): Promise<BrowserSettingsSnapshot> {
    if (mode !== 'headed' && mode !== 'headless') throw new Error('Browser mode is invalid.')
    await this.hydrateRuntime()
    const current = await this.manager.status()
    if (current.status === 'running' && current.mode !== mode) await this.manager.stop()
    this.manager.setMode(mode)
    await writeJsonAtomic(this.storagePath, { version: 1, mode })
    return this.snapshot()
  }

  async openProfile(): Promise<BrowserSettingsSnapshot> {
    await this.manager.openProfile()
    return this.snapshot()
  }

  async stop(): Promise<BrowserSettingsSnapshot> {
    await this.manager.stop()
    return this.snapshot()
  }

  private async hydratePersistedRuntime(): Promise<void> {
    await this.readPersistedMode()
    await this.manager.reconnectExistingProfile()
  }

  private async readPersistedMode(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.storagePath, 'utf8')) as { mode?: unknown }
      if (parsed.mode === 'headed' || parsed.mode === 'headless') this.manager.setMode(parsed.mode)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(temporary, filePath)
}
