import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { agentDialogueRecordSchema, type AgentDialogueRecord } from '../contracts/agent-dialogue.js'
import { writeFileAtomic } from '../core/file-mutation.js'
import { resolveExistingPathInside } from '../core/path-safety.js'
import { withFileLock } from '../domains/sessions/session-file-locks.js'
import type { SessionStore } from '../domains/sessions/session-store.js'

export class FileSystemDialogueStore {
  constructor(private readonly workspacePath: string, private readonly sessions: SessionStore) {}

  async save(record: AgentDialogueRecord): Promise<boolean> {
    const validated = agentDialogueRecordSchema.parse(record)
    return withFileLock(path.join(this.workspacePath, 'sessions', '.locks', `${validated.sessionId}.lock`), async () => {
      if (!await this.sessions.getSession(validated.sessionId)) return false
      const directory = this.directory(validated.sessionId)
      if (!directory) return false
      await writeFileAtomic(path.join(directory, `${validated.dialogueId}.json`), JSON.stringify(validated))
      return true
    })
  }

  async get(sessionId: string, dialogueId: string): Promise<AgentDialogueRecord | undefined> {
    const directory = this.directory(sessionId)
    if (!directory || !z.uuid().safeParse(dialogueId).success) return undefined
    const filename = path.join(directory, `${dialogueId}.json`)
    const contained = resolveExistingPathInside(path.join(this.workspacePath, 'sessions'), filename)
    if (!contained) return undefined
    let contents: string
    try {
      contents = await fs.readFile(filename, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw error
    }
    const raw: unknown = JSON.parse(contents)
    const record = agentDialogueRecordSchema.parse(raw)
    if (record.sessionId !== sessionId || record.dialogueId !== dialogueId) throw new Error('Dialogue record identity disagrees with its file')
    return record
  }

  async list(sessionId: string): Promise<AgentDialogueRecord[]> {
    const directory = this.directory(sessionId)
    if (!directory) return []
    let filenames: string[]
    try {
      filenames = await fs.readdir(directory)
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    const records: AgentDialogueRecord[] = []
    for (const filename of filenames) {
      if (!filename.endsWith('.json')) continue
      const record = await this.get(sessionId, filename.slice(0, -5))
      if (record) records.push(record)
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  private directory(sessionId: string): string | undefined {
    return this.sessions.dialogueRecordDirectory(sessionId)
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
