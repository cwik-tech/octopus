import assert from 'node:assert/strict'
import test from 'node:test'
import { OfficePreviewJobs } from '../../services/office-preview-jobs.js'
import { OFFICE_PROFILE, type OfficePreview } from '../../contracts/office-documents.js'

const preview: OfficePreview = { html: '<html><body>Report</body></html>', digest: 'a'.repeat(64), profile: OFFICE_PROFILE, notices: [] }
test('one cancelled subscriber cannot stop another subscriber to the same conversion', async () => {
  const jobs = new OfficePreviewJobs()
  const first = new AbortController()
  const second = new AbortController()
  let complete: (value: OfficePreview) => void = () => { throw new Error('Job did not start') }
  let runningSignal: AbortSignal | undefined
  const work = (signal: AbortSignal) => new Promise<OfficePreview>((resolve) => { complete = resolve; runningSignal = signal })
  const a = jobs.get('scope', 'same', first.signal, work)
  const b = jobs.get('scope', 'same', second.signal, work)
  first.abort()
  assert.deepEqual(await a, { ok: false, code: 'cancelled' })
  assert.equal(runningSignal?.aborted, false)
  complete(preview)
  assert.deepEqual(await b, preview)
})
test('the last subscriber aborts its job and cancellation never enters the cache', async () => {
  const jobs = new OfficePreviewJobs()
  const controller = new AbortController()
  const requested = jobs.get('scope', 'same', controller.signal, (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled' }), { once: true })))
  controller.abort()
  assert.deepEqual(await requested, { ok: false, code: 'cancelled' })
  assert.deepEqual(await jobs.get('scope', 'same', new AbortController().signal, async () => preview), preview)
})
test('closing a session invalidates cached previews and cancels its active work', async () => {
  const jobs = new OfficePreviewJobs()
  const signal = new AbortController().signal
  await jobs.get('scope', 'cached', signal, async () => preview)
  const pending = jobs.get('scope', 'running', signal, (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled' }), { once: true })))
  jobs.invalidate('scope')
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' })
  const fresh = { ...preview, html: '<html><body>Fresh</body></html>' }
  assert.deepEqual(await jobs.get('scope', 'cached', signal, async () => fresh), fresh)
})
