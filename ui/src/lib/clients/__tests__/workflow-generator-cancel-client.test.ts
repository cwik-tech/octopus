/**
 * The Stop acknowledgement, which crosses the network.
 *
 * It answers one question — did this turn end because somebody stopped it? —
 * and the two fields that answer it are one statement, not two. A body that
 * pairs them differently would let a turn somebody stopped be reported as
 * finished, or a turn that finished be reported as stopped, and the caller
 * cannot tell which half to believe. So the pairing is proved before the result
 * is called an acknowledgement.
 *
 * The `completed` answer exists because Stop can lose: a turn that had already
 * committed its outcome when Stop landed did finish, and saying otherwise would
 * be the same disagreement in reverse.
 */
import { afterEach, expect, it, vi } from 'vitest'

import { cancelGeneratorJob } from '@/lib/clients/workflow-generator-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

function respondWith(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

it('reads a cancellation the registry acknowledged', async () => {
  respondWith({ jobId: 'job-1', cancelled: true, status: 'cancelled' })

  await expect(cancelGeneratorJob('job-1')).resolves.toEqual({
    jobId: 'job-1',
    cancelled: true,
    status: 'cancelled',
  })
})

it('reads a cancellation remembered before the job started', async () => {
  respondWith({ jobId: 'job-1', cancelled: true, status: 'pending' })

  await expect(cancelGeneratorJob('job-1')).resolves.toEqual({
    jobId: 'job-1',
    cancelled: true,
    status: 'pending',
  })
})

it('reads a turn that had already finished when Stop landed', async () => {
  respondWith({ jobId: 'job-1', cancelled: false, status: 'completed' })

  await expect(cancelGeneratorJob('job-1')).resolves.toEqual({
    jobId: 'job-1',
    cancelled: false,
    status: 'completed',
  })
})

it('refuses an acknowledgement whose two halves disagree', async () => {
  // Cancelled and completed at once describes no turn. Passing it on would
  // hand the caller a choice about which half to trust.
  respondWith({ jobId: 'job-1', cancelled: true, status: 'completed' })

  await expect(cancelGeneratorJob('job-1')).rejects.toThrow(/does not describe an outcome/)
})

it('refuses an acknowledgement that names no job', async () => {
  respondWith({ cancelled: true, status: 'cancelled' })

  await expect(cancelGeneratorJob('job-1')).rejects.toThrow(/named no job/)
})

it('refuses a status it does not recognise', async () => {
  // `completing` is a moment inside the registry, not an outcome. It never
  // leaves the acknowledgement, and a body carrying it is not one to act on.
  respondWith({ jobId: 'job-1', cancelled: false, status: 'completing' })

  await expect(cancelGeneratorJob('job-1')).rejects.toThrow(/does not describe an outcome/)
})
