import * as fs from 'node:fs'
import * as path from 'node:path'

export function resolveDesktopHeadlessNodePath(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'darwin') return executablePath

  const macOsPath = path.dirname(executablePath)
  const contentsPath = path.dirname(macOsPath)
  if (
    path.basename(macOsPath) !== 'MacOS' ||
    path.basename(contentsPath) !== 'Contents'
  ) {
    return executablePath
  }
  const executableName = path.basename(executablePath)
  const helperName = `${executableName} Helper`
  return path.join(
    contentsPath,
    'Frameworks',
    `${helperName}.app`,
    'Contents',
    'MacOS',
    helperName,
  )
}

export function requireDesktopHeadlessNodePath(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const runtimePath = resolveDesktopHeadlessNodePath(executablePath, platform)
  try {
    if (fs.statSync(runtimePath).isFile()) return runtimePath
  } catch {
    // Throw one stable preflight error below.
  }
  throw new Error(`Desktop headless Node runtime is missing: ${runtimePath}`)
}
