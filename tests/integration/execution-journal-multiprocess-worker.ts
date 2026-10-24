import * as fs from 'node:fs'

import type {
  ExecutionJournalAppendOutcome,
  ExecutionJournalScopeIdentity,
} from '../../contracts/execution-journal.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'

async function main(): Promise<void> {
  const [scopeRoot, identityJson, mode, workerId, outputPath, countArg, expectedRevisionArg] =
    process.argv.slice(2)
  if (
    !scopeRoot ||
    !identityJson ||
    !mode ||
    !workerId ||
    !outputPath ||
    !countArg
  ) {
    throw new Error('execution-journal worker arguments are incomplete')
  }
  const identity = JSON.parse(identityJson) as ExecutionJournalScopeIdentity
  const journal = await initializeExecutionJournal({ scopeRoot, identity })
  try {
    const outcomes: ExecutionJournalAppendOutcome[] = []
    if (mode === 'burst') {
      const eventCount = Number.parseInt(countArg, 10)
      for (let index = 0; index < eventCount; index += 1) {
        outcomes.push(
          await journal.append({
            eventId: `${workerId}-event-${index}`,
            streamKind: 'test',
            streamId: workerId,
            expectedStreamRevision: index,
            type: 'test.observation',
            payloadSchemaVersion: 1,
            payload: { workerId, index },
            correlationId: `corr-${workerId}`,
          }),
        )
      }
    } else if (mode === 'race') {
      const expectedRevision = Number.parseInt(expectedRevisionArg ?? '0', 10)
      outcomes.push(
        await journal.append({
          eventId: `${workerId}-race`,
          streamKind: 'test',
          streamId: 'race',
          expectedStreamRevision: expectedRevision,
          type: 'test.observation',
          payloadSchemaVersion: 1,
          payload: { workerId },
          correlationId: 'corr-race',
        }),
      )
    } else {
      throw new Error(`Unknown worker mode: ${mode}`)
    }
    const [single] = outcomes
    fs.writeFileSync(
      outputPath,
      JSON.stringify(single ?? { kind: 'none' }),
      'utf8',
    )
  } finally {
    await journal.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
