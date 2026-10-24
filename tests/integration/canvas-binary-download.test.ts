import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { handleRunDetailRoutes } from '../../server/routes/runs.js'

for (const { extension, contentType } of [
  { extension: 'pdf', contentType: 'application/pdf' },
  { extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { extension: 'mp4', contentType: 'video/mp4' },
  { extension: 'webm', contentType: 'video/webm' },
  { extension: 'png', contentType: 'application/octet-stream' },
  { extension: 'zip', contentType: 'application/octet-stream' },
  { extension: 'bin', contentType: 'application/octet-stream' },
]) {
  test(`Canvas download preserves every byte of a ${extension} artifact through HTTP`, async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-download-'))
    const directory = path.join(workspacePath, 'assignments', 'download-run', 'files')
    await fs.mkdir(directory, { recursive: true })
    const content = Buffer.from('255044460afffefd0080', 'hex')
    await fs.writeFile(path.join(directory, `document.${extension}`), content)
    const store = new FileSystemRunStore(workspacePath)
    const server = http.createServer((req, res) => {
      void handleRunDetailRoutes({ req, res, url: new URL(req.url ?? '/', 'http://localhost'), options: { store, launcher: { async startRun() { throw new Error('Downloads cannot launch runs') } }, eventPollIntervalMs: 100, hasSessionTaskRuntime: true } }).catch((error: unknown) => { res.statusCode = 500; res.end(error instanceof Error ? error.message : 'Unexpected error') })
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const response = await fetch(`http://127.0.0.1:${address.port}/runs/download-run/assignments/files/document.${extension}`, { signal: AbortSignal.timeout(2000) })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), contentType)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
      assert.match(response.headers.get('content-disposition') ?? '', /attachment/)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await fs.rm(workspacePath, { recursive: true, force: true })
    }
  })
}
