import * as fs from 'node:fs'
import * as path from 'node:path'
import { sessionSummarySchema } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

/** Seed the synchronous legacy harnesses with real session ownership. */
export function seedChatSessionStore(workspacePath: string, sessionId: string): FileSystemSessionStore {
  const summary = sessionSummarySchema.parse({ id: sessionId, title: 'Chat fixture', status: 'active', activityType: 'chat', createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z' })
  const directory = path.join(workspacePath, 'sessions', sessionId)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'session.json'), JSON.stringify(summary))
  return new FileSystemSessionStore(workspacePath)
}
