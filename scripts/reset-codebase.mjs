import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const agentsDir = path.join(repoRoot, 'agents')
const workspaceDir = path.join(repoRoot, 'workspace')

const RESET_TEMPLATE = `<!--
After each session, append an entry below using this format:

### Session: [date] — [brief topic]
- **What worked:** [approaches/methods that produced good results]
- **What didn't:** [approaches that failed or produced weak results]
- **Pattern noticed:** [any recurring pattern worth remembering]
- **For next time:** [specific adjustment to try in future sessions]
-->
`

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function listAgentDirectories(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
}

async function resetExperienceFiles() {
  if (!(await pathExists(agentsDir))) {
    throw new Error(`Agents directory not found: ${agentsDir}`)
  }

  const agentDirectories = await listAgentDirectories(agentsDir)
  const resetFiles = []
  const missingFiles = []

  for (const agentDir of agentDirectories) {
    const scratchPadPath = path.join(agentDir, 'experience', 'scratch-pad.md')
    if (await pathExists(scratchPadPath)) {
      await fs.writeFile(scratchPadPath, RESET_TEMPLATE, 'utf8')
      resetFiles.push(path.relative(repoRoot, scratchPadPath))
      continue
    }

    missingFiles.push(path.relative(repoRoot, scratchPadPath))
  }

  console.log(`Reset ${resetFiles.length} experience file(s).`)
  for (const filePath of resetFiles) {
    console.log(`- ${filePath}`)
  }

  if (missingFiles.length > 0) {
    console.log(`Skipped ${missingFiles.length} missing experience file(s).`)
    for (const filePath of missingFiles) {
      console.log(`- ${filePath}`)
    }
  }
}

async function deleteWorkspaceFolder() {
  if (!(await pathExists(workspaceDir))) {
    console.log('Workspace folder not found. Nothing to delete.')
    return
  }

  await fs.rm(workspaceDir, { recursive: true, force: true })
  console.log(`Deleted workspace folder: ${path.relative(repoRoot, workspaceDir)}`)
}

async function resetCodebase() {
  await resetExperienceFiles()
  await deleteWorkspaceFolder()
}

resetCodebase().catch((error) => {
  console.error(`Failed to reset codebase: ${error.message}`)
  process.exitCode = 1
})
