import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveOfficeBinary } from '../../services/officecli-binary-resolver.js'

// Payload resolution is currently supported only for packaged macOS targets.
test('missing or mismatched local Office payloads never fall back to a global executable', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'office-resolver-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const signal = AbortSignal.timeout(2000)
  assert.equal(await resolveOfficeBinary(root, signal), undefined)
  const directory = path.join(root, 'build', 'office-tools', `${process.platform}-${process.arch}`)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'officecli'), 'untrusted payload')
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version: '1.0.157', platform: process.platform, arch: process.arch, file: 'officecli', upstreamSha256: '0'.repeat(64), sha256: '0'.repeat(64) }))

  assert.equal(await resolveOfficeBinary(root, signal), undefined)
})
