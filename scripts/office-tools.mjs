import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
const mode = process.argv[2] ?? 'verify'
const bundle = process.argv[3] ?? path.join('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Octopus.app')
const root = mode === 'verify-packaged' ? path.join(bundle, 'Contents', 'Resources', 'office-tools') : path.join('build', 'office-tools')
const directory = path.resolve(root, `${process.platform}-${process.arch}`)
const manifestPath = path.join(directory, 'manifest.json')
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
const pins = { 'darwin-arm64': '0dae0990a9cc29688a5d54469f984c34e5b15ab6bbd194a0ffdc571bb9040124', 'darwin-x64': '178c1e9ebaf44c24d2b4b359064a5dea6eb7b2f539809871a3de1c09599dff9f' }
if (manifest.version !== '1.0.157' || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.file !== 'officecli' || manifest.upstreamSha256 !== pins[`${process.platform}-${process.arch}`]) throw new Error('OfficeCLI manifest/platform/upstream pin mismatch.')
const executable = path.join(directory, manifest.file)
const checksum = async () => createHash('sha256').update(await fs.readFile(executable)).digest('hex')
if (await checksum() !== manifest.sha256) throw new Error('OfficeCLI packaged checksum mismatch; re-stage before signing.')
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) if (!(await fs.stat(path.join(directory, name))).isFile()) throw new Error(`Missing OfficeCLI ${name}`)
if (mode === 'sign') {
  const configured = process.env.OFFICE_TOOLS_SIGN_IDENTITY?.trim() || process.env.CSC_NAME?.trim()
  const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { timeout: 30000, maxBuffer: 256 * 1024 }).toString()
  const found = [...new Set([...identities.matchAll(/"(Developer ID Application[^\"]+)"/g)].map((match) => match[1]))]
  const identity = configured || (found.length === 1 ? found[0] : undefined)
  if (!identity && (found.length > 1 || process.env.CSC_LINK)) throw new Error('Set OFFICE_TOOLS_SIGN_IDENTITY to the app signing identity before packaging.')
  if (identity) {
    execFileSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp', '--entitlements', path.resolve('node_modules/app-builder-lib/templates/entitlements.mac.plist'), '--sign', identity, executable], { timeout: 300000, maxBuffer: 1024 * 1024 })
    manifest.sha256 = await checksum()
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
}
if (mode === 'verify-packaged') {
  const { officeToolSignatureIssue } = await import('../core/office-tool-signature.ts')
  const inspectSignature = (file) => {
    const report = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', file], { timeout: 30000, maxBuffer: 65536, encoding: 'utf8' })
    if (report.error) throw report.error
    if (report.status !== 0) throw new Error(`Cannot inspect code signature on ${file}.`)
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { timeout: 30000, maxBuffer: 65536 })
    const displayed = `${report.stdout}${report.stderr}`
    const team = /^TeamIdentifier=(.+)$/m.exec(displayed)?.[1]?.trim()
    const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/i.exec(displayed)?.[1] ?? ''
    return { team: team && team !== 'not set' ? team : null, runtime: flags.split(',').some((flag) => flag.trim() === 'runtime') }
  }
  const issue = officeToolSignatureIssue(inspectSignature(bundle), inspectSignature(executable))
  if (issue) throw new Error(`Packaged OfficeCLI signature rejected: ${issue}.`)

}
const privateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'office-verify-'))
try {
  const version = execFileSync(executable, ['--version'], { cwd: privateHome, env: { HOME: privateHome, TMPDIR: privateHome, PATH: '', OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_INSTALL: '1', OFFICECLI_NO_AUTO_RESIDENT: '1' }, timeout: 15000, maxBuffer: 65536 }).toString().trim()
  if (version !== '1.0.157') throw new Error('OfficeCLI version mismatch.')
} finally { await fs.rm(privateHome, { recursive: true, force: true }) }
process.stdout.write(`OfficeCLI ${mode}: pinned ${process.platform}-${process.arch} payload verified.\n`)
