import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const pins = {
  'darwin-arm64': '0dae0990a9cc29688a5d54469f984c34e5b15ab6bbd194a0ffdc571bb9040124',
  'darwin-x64': '178c1e9ebaf44c24d2b4b359064a5dea6eb7b2f539809871a3de1c09599dff9f',
}
const source = process.argv[2]
const notices = process.argv[3]
const expected = pins[`${process.platform}-${process.arch}`]
if (!source || !notices || !expected) throw new Error('Usage: node scripts/stage-office-tools.mjs <approved-release-executable> <release-source-directory>; supported targets: macOS arm64/x64.')
const bytes = await fs.readFile(source)
const upstreamSha256 = createHash('sha256').update(bytes).digest('hex')
if (upstreamSha256 !== expected) throw new Error('OfficeCLI upstream SHA-256 mismatch.')
const directory = path.resolve('build', 'office-tools', `${process.platform}-${process.arch}`)
await fs.mkdir(directory, { recursive: true })
const executable = path.join(directory, 'officecli')
await fs.writeFile(executable, bytes, { mode: 0o755 })
await fs.chmod(executable, 0o755)
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) await fs.copyFile(path.join(notices, name), path.join(directory, name))
const privateHome = await fs.mkdtemp(path.join(directory, '.version-'))
try {
  const version = execFileSync(executable, ['--version'], { cwd: privateHome, env: { HOME: privateHome, TMPDIR: privateHome, PATH: '', OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_INSTALL: '1', OFFICECLI_NO_AUTO_RESIDENT: '1' }, timeout: 15000, maxBuffer: 65536 }).toString().trim()
  if (version !== '1.0.157') throw new Error('OfficeCLI version mismatch.')
} finally { await fs.rm(privateHome, { recursive: true, force: true }) }
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version: '1.0.157', platform: process.platform, arch: process.arch, file: 'officecli', upstreamSha256, sha256: upstreamSha256 }, null, 2) + '\n')
