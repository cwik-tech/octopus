/**
 * The run child's sender: bounded, single-flight, and never in the way.
 *
 * This runs on the model's hot path in a detached process. Two things follow
 * from that and shape every test here. It must never slow generation down —
 * so no send is ever awaited by the caller, and at most one is in flight. And
 * it must never grow without limit — so when it cannot keep up it drops the
 * oldest frames and says so, because silent loss is the one failure this whole
 * channel exists to prevent.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentTextDeltaSender } from '../../domains/runtime/agent-text-delta-sender.js'

const URL_ = 'http://127.0.0.1:4321/internal/agent-text-stream'
const CHANNEL = '11111111-2222-4333-8444-555555555555'
const TOKEN = 'a-working-credential'

interface Capture {
  readonly url: string
  readonly authorization: string | undefined
  readonly body: {
    channelId?: string
    frames?: Array<Record<string, unknown>>
  }
  readonly settle: () => void
  readonly fail: () => void
}

/** A fetch stand-in whose every request is settled by the test. */
function createTransport() {
  const captures: Capture[] = []
  let inFlight = 0
  let maxInFlight = 0
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    const headers = new Headers(init.headers)
    let settle!: () => void
    let fail!: () => void
    const settled = new Promise<Response>((resolve, reject) => {
      settle = () => {
        inFlight -= 1
        resolve(new Response(null, { status: 202 }))
      }
      fail = () => {
        inFlight -= 1
        reject(new Error('the parent is gone'))
      }
    })
    captures.push({
      url,
      authorization: headers.get('authorization') ?? undefined,
      body: JSON.parse(String(init.body ?? '{}')),
      settle,
      fail,
    })
    return settled
  }
  return {
    captures,
    send,
    maxInFlight: () => maxInFlight,
    settleAll: () => {
      for (const capture of [...captures]) capture.settle()
    },
  }
}

function delta(text: string, producerSequence: number) {
  return {
    type: 'delta' as const,
    replyId: 'dispatch-1',
    channel: 'text' as const,
    text,
    producerSequence,
  }
}

/** Let queued microtasks and the coalescing timer run. */
async function settleTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Wait for a condition rather than for a fixed number of ticks. The rules
 * under test are about ordering and batching, not about how many turns of the
 * event loop the sender happens to take.
 */
async function waitFor(
  condition: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

test('the credential travels in a header and never in the address', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
  })

  sender.send(delta('Kestrel', 0))
  await settleTimers()

  const first = transport.captures[0]
  assert.ok(first)
  assert.equal(first.url, URL_)
  assert.equal(first.url.includes(TOKEN), false)
  assert.equal(first.authorization, `Bearer ${TOKEN}`)
  assert.equal(first.body.channelId, CHANNEL)
  transport.settleAll()
  await sender.close()
})

test('frames produced during a send ride the next one, and only one is ever in flight', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
  })

  sender.send(delta('one', 0))
  await settleTimers()
  // While that request is still open, three more arrive.
  sender.send(delta('two', 1))
  sender.send(delta('three', 2))
  sender.send(delta('four', 3))
  await settleTimers()

  assert.equal(transport.captures.length, 1, 'a second request overlapped')
  transport.captures[0]?.settle()
  await waitFor(
    () => transport.captures.length === 2,
    'the queued frames were never sent after the first request settled',
  )

  assert.equal(transport.maxInFlight(), 1)
  assert.deepEqual(
    transport.captures[1]?.body.frames?.map((frame) => frame.text),
    ['two', 'three', 'four'],
  )
  transport.settleAll()
  await sender.close()
})

test('a send that fails is dropped rather than retried, and never reaches the caller', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
  })

  // Returns nothing and throws nothing: the generation path must not learn
  // that the display channel had a problem.
  assert.equal(sender.send(delta('one', 0)), undefined)
  await settleTimers()
  transport.captures[0]?.fail()
  await settleTimers()

  // Nothing is resent. The lost frame is the hub's problem to report, not
  // something to replay into a bubble that has moved on.
  assert.equal(transport.captures.length, 1)

  sender.send(delta('two', 1))
  await waitFor(
    () => transport.captures.length === 2,
    'the sender stopped sending after one failure',
  )
  assert.deepEqual(
    transport.captures[1]?.body.frames?.map((frame) => frame.text),
    ['two'],
  )
  transport.settleAll()
  await sender.close()
})

test('a backlog past the cap drops its oldest frames and leaves a hole the hub can see', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
    // Comfortably larger than one frame and far smaller than the backlog, so
    // this is about dropping the oldest rather than about oversized frames.
    maxPendingBytes: 400,
    batchFlushBytes: 1_000_000,
  })

  sender.send(delta('first', 0))
  await settleTimers()
  // The first request is still open, so everything below queues behind it.
  for (let index = 1; index <= 20; index += 1) {
    sender.send(delta(`padding-${index}`.padEnd(32, '.'), index))
  }
  transport.captures[0]?.settle()
  await waitFor(
    () => transport.captures.length === 2,
    'the backlog was never sent',
  )

  const sent = transport.captures[1]?.body.frames ?? []
  assert.ok(sent.length > 0, 'the backlog was dropped entirely')
  // The oldest go, not the newest: a preview that lags further and further
  // behind is worse than one that skips.
  assert.notEqual(sent[0]?.producerSequence, 1)
  // The gap is visible in producer space, which is what makes the hub emit a
  // `gap` rather than splicing text across the hole.
  assert.ok(
    Number(sent[0]?.producerSequence) > 1,
    'the surviving frames did not advance past what was dropped',
  )
  transport.settleAll()
  await sender.close()
})

test('closing flushes what is still pending', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 10_000,
  })

  sender.send(delta('final answer', 0))
  const closing = sender.close()
  await settleTimers()

  assert.equal(transport.captures.length, 1)
  assert.deepEqual(
    transport.captures[0]?.body.frames?.map((frame) => frame.text),
    ['final answer'],
  )
  transport.settleAll()
  await closing
})

test('sending after close does nothing at all', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
  })

  await sender.close()
  sender.send(delta('too late', 0))
  await settleTimers()

  assert.equal(transport.captures.length, 0)
})

test('the cap counts bytes, so multibyte text cannot slip past it', async () => {
  const transport = createTransport()
  // Each emoji is two UTF-16 units and four UTF-8 bytes, so counting
  // characters understates every frame by half and lets roughly twice the
  // stated budget through. The cap below is chosen so the two ways of
  // counting disagree about how many frames fit.
  const emoji = '👋'.repeat(50)
  const maxPendingBytes = 500
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
    maxPendingBytes,
    batchFlushBytes: 1_000_000,
  })

  sender.send(delta('first', 0))
  await settleTimers()
  for (let index = 1; index <= 6; index += 1) {
    sender.send(delta(emoji, index))
  }
  transport.captures[0]?.settle()
  await waitFor(
    () => transport.captures.length === 2,
    'the backlog was never sent',
  )

  const sent = transport.captures[1]?.body.frames ?? []
  const bytes = sent.reduce(
    (total, frame) => total + Buffer.byteLength(JSON.stringify(frame), 'utf8'),
    0,
  )
  assert.ok(
    bytes <= maxPendingBytes,
    `the pending backlog held ${bytes} bytes against a ${maxPendingBytes} byte cap`,
  )
})

test('a batch that reaches the size threshold goes at once instead of waiting for the timer', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    // Long enough that a timer-driven flush could not explain the send.
    flushIntervalMs: 60_000,
    batchFlushBytes: 200,
  })

  sender.send(delta('x'.repeat(500), 0))
  await waitFor(
    () => transport.captures.length === 1,
    'a batch past the size threshold waited for the timer',
  )

  transport.settleAll()
  await sender.close()
})

test('closing is bounded even when the parent never answers', async () => {
  // Ignores its signal entirely, which is the case a terminal deadline has to
  // survive. Nothing here ever settles it.
  const send = (): Promise<Response> => new Promise<Response>(() => {})
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send,
    flushIntervalMs: 0,
    terminalFlushTimeoutMs: 50,
  })

  sender.send(delta('final answer', 0))
  // Raced against the suite's own deadline rather than awaited: a `close`
  // that never returns must fail this test promptly, not hang the run.
  const timedOut = Symbol('timed out')
  const outcome = await Promise.race([
    sender.close().then(() => 'closed' as const),
    new Promise<typeof timedOut>((resolve) => {
      const timer = setTimeout(() => resolve(timedOut), 1_000)
      timer.unref?.()
    }),
  ])

  assert.equal(
    outcome,
    'closed',
    'close waited on a request that was never going to settle',
  )
})

test('closing twice waits on the same close rather than starting another', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
    // Long enough that a close resolving on this deadline is distinguishable
    // from one resolving because its request settled.
    terminalFlushTimeoutMs: 5_000,
  })

  sender.send(delta('final answer', 0))
  const startedAt = Date.now()
  const first = sender.close()
  const second = sender.close()
  await settleTimers()
  transport.settleAll()
  await Promise.all([first, second])

  assert.equal(transport.captures.length, 1, 'the second close sent again')
  // A second close that started its own wait would leave the first one to
  // time out instead of finishing when the request it was waiting on did.
  assert.ok(
    Date.now() - startedAt < 1_000,
    'a close waited out its deadline instead of the request it was watching',
  )
})

test('one frame larger than the whole budget is dropped instead of being held alone', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
    maxPendingBytes: 128,
    batchFlushBytes: 1_000_000,
  })

  // Nothing else arrives to displace it. Keeping it would put the sender over
  // the bound it states, and the parent would refuse it anyway.
  sender.send(delta('x'.repeat(4_000), 0))
  await settleTimers()
  await settleTimers()

  assert.deepEqual(
    transport.captures.map((capture) => capture.body.frames?.length ?? 0),
    [],
    'an oversized frame was kept and sent',
  )
  await sender.close()
})

test('a single frame larger than the whole budget is dropped rather than held', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
    maxPendingBytes: 128,
    batchFlushBytes: 1_000_000,
  })

  // Keeping this would put the sender over its own stated bound, and the
  // parent would refuse it anyway. It is dropped, and the hole it leaves is
  // what the hub reports.
  sender.send(delta('x'.repeat(4_000), 0))
  sender.send(delta('small', 1))
  await waitFor(
    () => transport.captures.length === 1,
    'nothing was ever sent',
  )

  assert.deepEqual(
    transport.captures[0]?.body.frames?.map((frame) => frame.producerSequence),
    [1],
  )
  transport.settleAll()
  await sender.close()
})

test('flushing delivers what is queued and only then returns', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    // Long enough that a flush resolving on its own is unmistakable: nothing
    // here can be explained by the coalescing timer firing.
    flushIntervalMs: 60_000,
    terminalFlushTimeoutMs: 5_000,
  })

  sender.send(delta('the whole answer', 0))
  let settled = false
  const flushed = sender.flush().then(() => {
    settled = true
  })

  await waitFor(
    () => transport.captures.length === 1,
    'flush did not send what was queued',
  )
  assert.equal(
    settled,
    false,
    'flush returned before the parent had accepted the frames',
  )

  transport.settleAll()
  await flushed
  assert.equal(settled, true)
  assert.deepEqual(
    transport.captures[0]?.body.frames?.map((frame) => frame.text),
    ['the whole answer'],
  )
})

test('flushing leaves the sender open for the frames that come after it', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
    terminalFlushTimeoutMs: 5_000,
  })

  sender.send(delta('first', 0))
  const first = sender.flush()
  await waitFor(() => transport.captures.length === 1, 'the first flush never sent')
  transport.settleAll()
  await first

  // A dispatch flushing its own tail must not silence the dispatches that
  // follow it on the same channel.
  sender.send(delta('second', 1))
  const second = sender.flush()
  await waitFor(() => transport.captures.length === 2, 'the sender was closed by a flush')
  transport.settleAll()
  await second

  assert.deepEqual(
    transport.captures.flatMap((capture) =>
      (capture.body.frames ?? []).map((frame) => frame.text),
    ),
    ['first', 'second'],
  )
})

test('flushing is bounded even when the parent never answers', async () => {
  const send = (): Promise<Response> => new Promise<Response>(() => {})
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send,
    flushIntervalMs: 0,
    terminalFlushTimeoutMs: 50,
  })

  sender.send(delta('the whole answer', 0))
  const timedOut = Symbol('timed out')
  const outcome = await Promise.race([
    sender.flush().then(() => 'flushed' as const),
    new Promise<typeof timedOut>((resolve) => {
      const timer = setTimeout(() => resolve(timedOut), 1_000)
      timer.unref?.()
    }),
  ])

  assert.equal(
    outcome,
    'flushed',
    'a flush waited on a request that was never going to settle',
  )
})

test('flushing an empty queue returns without sending anything', async () => {
  const transport = createTransport()
  const sender = createAgentTextDeltaSender({
    url: URL_,
    channelId: CHANNEL,
    token: TOKEN,
    send: transport.send,
    flushIntervalMs: 0,
  })

  await sender.flush()
  assert.equal(transport.captures.length, 0)
})
