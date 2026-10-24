import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

interface CodexAuthFile {
  auth_mode?: unknown
  tokens?: {
    access_token?: unknown
  }
}

function resolveCodexAuthPath(
  environment: NodeJS.ProcessEnv,
  homeDirectory = os.homedir(),
): string {
  const codexHome = environment.CODEX_HOME?.trim()
  return path.join(codexHome || path.join(homeDirectory, '.codex'), 'auth.json')
}

function readCodexAuthFile(environment: NodeJS.ProcessEnv): CodexAuthFile {
  const authPath = resolveCodexAuthPath(environment)
  let raw: string
  try {
    raw = fs.readFileSync(authPath, 'utf8')
  } catch {
    throw new Error('Codex is not logged in. Run `codex login` and choose ChatGPT subscription login.')
  }

  try {
    return JSON.parse(raw) as CodexAuthFile
  } catch {
    throw new Error('Codex login state is invalid. Run `codex logout`, then `codex login`.')
  }
}

/** Read the existing Codex CLI ChatGPT OAuth token without persisting or logging it. */
export function readCodexSubscriptionAccessToken(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const auth = readCodexAuthFile(environment)
  if (String(auth.auth_mode ?? '').toLowerCase() !== 'chatgpt') {
    throw new Error(
      'Codex must use ChatGPT subscription login. Run `codex logout`, then `codex login` without an API key.',
    )
  }

  const accessToken = auth.tokens?.access_token
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new Error('Codex ChatGPT subscription token is missing. Run `codex login` again.')
  }
  return accessToken.trim()
}

export function validateCodexSubscriptionAuth(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    readCodexSubscriptionAccessToken(environment)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
