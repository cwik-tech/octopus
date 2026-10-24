import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { GENERAL_AGENT_NAME } from '../../domains/sessions/front-door.js'

/**
 * This repository, minus the front door.
 *
 * For contract tests about the Run Coordinator's plan. The only way the
 * sessions endpoint reaches the Coordinator is an untargeted turn, and against
 * the real repository that turn now belongs to the General Agent — whose
 * shipped persona names a CLI provider, so such a case is either answered by
 * the wrong identity or left waiting on a real one. Everything else has to
 * stay exactly as it is, because these tests run the repository's own
 * workflows and teams.
 *
 * Every entry is a symlink into the real repository. Remove one with
 * `removeMirroredRepository`, never with a recursive delete.
 */
export function mirrorRepositoryWithoutFrontDoor(prefix = 'repo-mirror-'): string {
  const source = process.cwd()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  for (const entry of fs.readdirSync(source)) {
    if (entry === 'agents') continue
    fs.symlinkSync(path.join(source, entry), path.join(root, entry))
  }
  const agentsDir = path.join(root, 'agents')
  fs.mkdirSync(agentsDir)
  for (const entry of fs.readdirSync(path.join(source, 'agents'))) {
    if (entry === GENERAL_AGENT_NAME) continue
    fs.symlinkSync(path.join(source, 'agents', entry), path.join(agentsDir, entry))
  }
  return root
}

/**
 * Unlink, never recurse.
 *
 * Every entry in a mirror points into the real repository, and a recursive
 * delete that followed one would take the repository with it.
 */
export function removeMirroredRepository(root: string): void {
  const agentsDir = path.join(root, 'agents')
  for (const entry of fs.readdirSync(agentsDir)) {
    fs.unlinkSync(path.join(agentsDir, entry))
  }
  fs.rmdirSync(agentsDir)
  for (const entry of fs.readdirSync(root)) {
    fs.unlinkSync(path.join(root, entry))
  }
  fs.rmdirSync(root)
}
