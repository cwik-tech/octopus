/**
 * Exact files, bytes and refusals of the agent-question content store, and
 * the store's own check that its private runtime folder stays in place.
 *
 * A question's request, saved continuation, answers and accepted result live
 * outside workflow-state.json, in `.runtime/agent-questions/<sha256>.json`,
 * and the state keeps only `{ sha256, byteLength }` for each. These tests
 * drive the store's public methods against real files and pin:
 *
 * - the stored bytes, file names, modes and the multibyte round trip;
 * - each refused read by its message: a size mismatch, a digest mismatch
 *   (including bytes that differ but decode to the same text), and a missing
 *   file, reported as missing;
 * - a continuation or result too large for a content file, refused as input
 *   before anything is saved, and the writer's own store error for oversize;
 * - a content file shared by identical questions, kept as saved, and refused
 *   when it was changed since;
 * - a content folder that is a link or a regular file, refused;
 * - a private runtime folder replaced by a link after the store was opened,
 *   refused before a locked operation, a question read (journal-enrolled or
 *   not) and a manifest read, with nothing written where the link points.
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { ZodError } from 'zod'
import type { RequestAgentInput } from '../../contracts/agent-questions.js'
import { FileSystemWorkflowStateStore, hashWorkflowContent } from '../../workflows/workflow-state-store.js'
import { writeAgentQuestionContentFile } from '../../workflows/workflow-agent-question-content.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { createJournalBackedWorkflowRecorder } from '../../workflows/workflow-journal.js'

const REQUEST = {
  progress: 'I need the recipient before I can finish the dedication.',
  questions: [{ question: 'Who is the dedication for — Zoë or Łucja?', reason: 'The recipient is required.' }],
}
// Keys deliberately out of order: the stored text sorts them.
const CONTINUATION = {
  systemPrompt: 'You are the dedication writer.', userMessage: 'Write the requested dedication.',
  provider: 'openai', model: 'fixture-model', thinking: 'low',
} as const
const ANSWERS = { 'question-one:1': 'Zoë Łucja 🌸' }
const RESULT = {
  text: 'Dla Zoë — kwiat o poranku.', model: 'fixture-model', toolCallCount: 0, executedToolCallCount: 0,
  usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
}

/** What each content kind is stored as, byte for byte. */
const STORED = {
  request: {
    text: '{"progress":"I need the recipient before I can finish the dedication.","questions":[{"question":"Who is the dedication for — Zoë or Łucja?","reason":"The recipient is required."}]}',
    reference: { sha256: '40567d98f023992210e9cd5a906c80ccd69a4fc5b2e28cdeb6477f4df959574b', byteLength: 184 },
  },
  continuation: {
    text: '{"model":"fixture-model","provider":"openai","systemPrompt":"You are the dedication writer.","thinking":"low","userMessage":"Write the requested dedication."}',
    reference: { sha256: '7b63f39c3452562fd7acdcc6af2f682b3e47871260f2218dd8289808196a8573', byteLength: 158 },
  },
  answers: {
    text: '{"question-one:1":"Zoë Łucja 🌸"}',
    reference: { sha256: '2a2a9946743ed5b1268ff1aa641e9db1e95fd65ce6cddab5418de9556dbc9dfb', byteLength: 37 },
  },
  result: {
    text: '{"executedToolCallCount":0,"model":"fixture-model","text":"Dla Zoë — kwiat o poranku.","toolCallCount":0,"usage":{"inputTokens":10,"outputTokens":12,"totalTokens":22}}',
    reference: { sha256: '622d8cc22ba11474f499aef23232da61a060bcabe2e6cfa3c1a95e29bf6f5e1d', byteLength: 170 },
  },
} as const

function questionInput(): RequestAgentInput {
  return {
    executionAttemptId: 'attempt-one', stepId: 'write',
    invocation: {
      agentId: 'writer', agentDisplayName: 'Dedication Writer', logicalInvocationId: 'chain-step-one',
      dispatchId: 'dispatch-one', childRunId: 'child-one', teamId: 'poets', stageId: 'chain',
      definitionHash: hashWorkflowContent('writer-v1'),
    },
    request: REQUEST,
    continuation: { ...CONTINUATION },
  }
}

async function makeWorkspace(t: TestContext) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-question-content-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  const assignment = path.join(workspace, 'assignments', 'root-one')
  await fs.mkdir(assignment, { recursive: true })
  return { workspace, assignment, contentDirectory: path.join(assignment, '.runtime', 'agent-questions') }
}

/** A workflow whose one step is running and may ask. */
async function startRunningStep(store: FileSystemWorkflowStateStore) {
  await store.initialize({
    manifest: {
      taskId: 'task-one', sessionId: 'session-one', rootRunId: 'root-one', workflowId: 'chain-one',
      workflowDefinitionHash: hashWorkflowContent('chain-one'), briefHash: hashWorkflowContent('dedication'),
      teamDefinitionHashes: { poets: hashWorkflowContent('poets') }, runtimeVersion: 'test-v1',
    },
    executionAttemptId: 'attempt-one',
    steps: [{
      stepId: 'write', stepIndex: 0, stepType: 'team', team: 'poets', childRunId: 'child-one',
      definitionHash: hashWorkflowContent('write'), recoveryPolicy: 'safe_retry',
      inputArtifact: 'brief.md', resultArtifact: 'poem.md', requestedResultType: 'artifact:poem.md',
    }],
  })
  await store.update({ expectedRevision: 0, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'launching'
    step.attemptCount = 1
    step.startedAt = '2026-09-19T12:00:00.000Z'
    draft.currentStepId = step.stepId
  } })
  await store.update({ expectedRevision: 1, executionAttemptId: 'attempt-one', mutate: (draft) => {
    const step = draft.steps[0]
    assert.ok(step)
    step.status = 'running'
  } })
}

function storeOptions() {
  return { now: () => new Date('2026-09-19T12:00:00.000Z'), randomUUID: () => 'question-one' }
}

async function makeRunningStore(t: TestContext) {
  const fixture = await makeWorkspace(t)
  const store = new FileSystemWorkflowStateStore(fixture.assignment, storeOptions())
  await startRunningStep(store)
  return { ...fixture, store }
}

/** Ask, answer, admit the continuation and accept its result. */
async function answerAndResolve(store: FileSystemWorkflowStateStore) {
  const asked = await store.requestAgentInput(questionInput())
  assert.deepEqual(asked, { kind: 'awaiting_input', interactionId: 'question-one' })
  await store.submitAgentInput({
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: STORED.request.reference.sha256,
    submissionId: 'answer-one', answers: ANSWERS,
  })
  await store.claimAgentQuestionContinuation({
    interactionId: 'question-one', submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two',
    continuationAdmissionRequestId: 'admission-one',
  })
  await store.resolveAgentQuestion({
    executionAttemptId: 'attempt-two', interactionId: 'question-one',
    agentId: 'writer', logicalInvocationId: 'chain-step-one', result: RESULT,
  })
}

function fileName(kind: keyof typeof STORED): string {
  return `${STORED[kind].reference.sha256}.json`
}

test('each saved content is its canonical JSON in a file named by its digest, and the state keeps only the digest and byte length', async (t) => {
  const { store, contentDirectory } = await makeRunningStore(t)
  await answerAndResolve(store)

  assert.deepEqual((await fs.readdir(contentDirectory)).sort(),
    [fileName('request'), fileName('continuation'), fileName('answers'), fileName('result')].sort(),
    'One file per content, and no temporary file left behind')
  for (const kind of ['request', 'continuation', 'answers', 'result'] as const) {
    assert.deepEqual(await fs.readFile(path.join(contentDirectory, fileName(kind))),
      Buffer.from(STORED[kind].text, 'utf8'), `${kind} bytes`)
  }

  const interaction = (await store.load())?.state.agentQuestions?.interactions[0]
  assert.ok(interaction?.status === 'resolved')
  assert.equal(interaction.requestDigest, STORED.request.reference.sha256)
  assert.deepEqual(interaction.requestContent, STORED.request.reference)
  assert.deepEqual(interaction.continuationContent, STORED.continuation.reference)
  assert.equal(interaction.submission.answerDigest, STORED.answers.reference.sha256)
  assert.deepEqual(interaction.submission.answerContent, STORED.answers.reference)
  assert.deepEqual(interaction.resultContent, STORED.result.reference)
})

test('multibyte content reads back unchanged through the full read and the display read', async (t) => {
  const { store } = await makeRunningStore(t)
  await answerAndResolve(store)

  const saved = await store.readAgentQuestion('question-one')
  assert.deepEqual(
    { request: saved.request, continuation: saved.continuation, answers: saved.answers, result: saved.result },
    { request: REQUEST, continuation: CONTINUATION, answers: ANSWERS, result: RESULT },
  )
  assert.deepEqual(await store.readAgentQuestionDisplay(saved.interaction), { request: REQUEST, answers: ANSWERS })
})

test('the content folder and each content file are private to their owner', async (t) => {
  const { store, contentDirectory } = await makeRunningStore(t)
  await answerAndResolve(store)

  // Limit: these modes show the store's own modes only while the umask leaves
  // group or other bits, as the usual 022 does. Under 077 a folder or file
  // made with a looser mode would also read back as 0o700 or 0o600.
  assert.equal((await fs.stat(contentDirectory)).mode & 0o777, 0o700)
  for (const name of await fs.readdir(contentDirectory)) {
    assert.equal((await fs.stat(path.join(contentDirectory, name))).mode & 0o777, 0o600, name)
  }
})

test('a refused content read names what failed', async (t) => {
  const { store, contentDirectory } = await makeRunningStore(t)
  await store.requestAgentInput(questionInput())
  const requestPath = path.join(contentDirectory, fileName('request'))
  const original = await fs.readFile(requestPath, 'utf8')

  await fs.writeFile(requestPath, `${original} `)
  await assert.rejects(store.readAgentQuestion('question-one'),
    { code: 'corrupt', message: 'The question content size does not match its reference.' })

  await fs.writeFile(requestPath, original.replace('dedication', 'dedicatioN'))
  await assert.rejects(store.readAgentQuestion('question-one'),
    { code: 'corrupt', message: 'The question content digest does not match its reference.' })

  // A missing file is reported as missing, not as a file outside the
  // assignment.
  await fs.unlink(requestPath)
  await assert.rejects(store.readAgentQuestion('question-one'),
    { code: 'corrupt', message: 'The question content is missing.' })
})

test('a content file whose bytes change but still decode to the same text is refused', async (t) => {
  // U+FFFD is stored as EF BF BD. The three bytes F0 90 80 are an unfinished
  // four-byte sequence, which a UTF-8 decoder also reads as one U+FFFD, so the
  // decoded text is identical while the bytes are not.
  const replacement = String.fromCharCode(0xfffd)
  const { store, contentDirectory } = await makeRunningStore(t)
  const input = questionInput()
  await store.requestAgentInput({
    ...input,
    request: { ...REQUEST, questions: [{ question: `Keep the mark ${replacement} as written?`, reason: 'It is in the source.' }] },
  })
  const requestPath = (await fs.readdir(contentDirectory))
    .map((name) => path.join(contentDirectory, name))
    .find((candidate) => candidate !== path.join(contentDirectory, fileName('continuation')))
  assert.ok(requestPath)
  const original = await fs.readFile(requestPath)
  const at = original.indexOf(Buffer.from([0xef, 0xbf, 0xbd]))
  assert.ok(at >= 0, 'the stored request holds U+FFFD')
  const substituted = Buffer.from(original)
  substituted.set([0xf0, 0x90, 0x80], at)
  assert.equal(substituted.toString('utf8'), original.toString('utf8'), 'the substitution decodes to the same text')
  await fs.writeFile(requestPath, substituted)

  await assert.rejects(store.readAgentQuestion('question-one'),
    { code: 'corrupt', message: 'The question content digest does not match its reference.' })
})

/** True when `error` refuses the value at `field` for not fitting in a saved content file. */
function refusesOversizedContent(error: unknown, field: string): boolean {
  return error instanceof ZodError && error.issues.some((issue) =>
    issue.path[0] === field && issue.message === 'A saved question content must fit in 8,000,000 bytes.')
}

async function contentFiles(contentDirectory: string): Promise<string[]> {
  return fs.readdir(contentDirectory).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })
}

test('a continuation that cannot fit in a saved content file is refused as input, before anything is saved', async (t) => {
  const { store, contentDirectory } = await makeRunningStore(t)
  // Each prompt is within its 2,000,000-character limit, but at three bytes a
  // character the continuation's canonical text is about 12 MB, over the
  // 8,000,000 bytes a content reference admits.
  const wide = '€'.repeat(2_000_000)
  const input = questionInput()

  await assert.rejects(store.requestAgentInput({ ...input, continuation: { ...input.continuation, systemPrompt: wide, userMessage: wide } }),
    (error) => refusesOversizedContent(error, 'continuation'))
  const state = (await store.load())?.state
  assert.equal(state?.revision, 2)
  assert.equal(state?.agentQuestions, undefined)
  // Not even the request is saved: nothing is left for no state to name.
  assert.deepEqual(await contentFiles(contentDirectory), [])
})

test('a result that cannot fit in a saved content file is refused as input, and the question stays open', async (t) => {
  const { store, contentDirectory } = await makeRunningStore(t)
  await store.requestAgentInput(questionInput())
  await store.submitAgentInput({
    taskId: 'task-one', sessionId: 'session-one', interactionId: 'question-one',
    expectedInteractionRevision: 0, expectedRequestDigest: STORED.request.reference.sha256,
    submissionId: 'answer-one', answers: ANSWERS,
  })
  await store.claimAgentQuestionContinuation({
    interactionId: 'question-one', submissionId: 'answer-one',
    expectedOwnerExecutionAttemptId: 'attempt-one', nextExecutionAttemptId: 'attempt-two',
    continuationAdmissionRequestId: 'admission-one',
  })
  const before = (await contentFiles(contentDirectory)).sort()

  // Within the result's 4,000,000-character limit, about 9 MB as UTF-8.
  await assert.rejects(store.resolveAgentQuestion({
    executionAttemptId: 'attempt-two', interactionId: 'question-one',
    agentId: 'writer', logicalInvocationId: 'chain-step-one',
    result: { ...RESULT, text: '€'.repeat(3_000_000) },
  }), (error) => refusesOversizedContent(error, 'result'))
  assert.equal((await store.load())?.state.agentQuestions?.interactions[0]?.status, 'resuming')
  assert.deepEqual((await contentFiles(contentDirectory)).sort(), before)
})

test('the content writer refuses a value over the reference ceiling with a store error, before making any folder', async (t) => {
  const { assignment, contentDirectory } = await makeWorkspace(t)
  const runtime = path.join(assignment, '.runtime')
  await fs.mkdir(runtime, { mode: 0o700 })

  await assert.rejects(writeAgentQuestionContentFile(assignment, runtime, { text: '€'.repeat(3_000_000) }),
    { code: 'invalid_state', message: 'The question content is larger than 8,000,000 bytes.' })
  assert.deepEqual(await contentFiles(contentDirectory), [])
})

test('a content folder that is a symbolic link is refused even when it points inside the assignment', async (t) => {
  const { store, assignment, contentDirectory } = await makeRunningStore(t)
  const inside = path.join(assignment, 'shared-content')
  await fs.mkdir(inside)
  await fs.symlink(inside, contentDirectory)

  await assert.rejects(store.requestAgentInput(questionInput()),
    { code: 'corrupt', message: 'The question storage is outside its assignment.' })
  assert.deepEqual(await fs.readdir(inside), [])
  assert.equal((await store.load())?.state.agentQuestions, undefined)
})

test('a question is refused and no content folder is made when the private runtime folder is moved outside the assignment after the store was opened', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  const runtime = path.join(assignment, '.runtime')
  const outside = path.join(path.dirname(assignment), 'outside-runtime')
  await fs.rename(runtime, outside)
  await fs.symlink(outside, runtime)

  // Refused before the lock is taken, by the store's own check.
  await assert.rejects(store.requestAgentInput(questionInput()),
    { code: 'corrupt', message: 'The workflow storage is outside its assignment.' })
  assert.equal((await fs.readdir(outside)).includes('agent-questions'), false)
})

async function makeTwoQuestionStore(t: TestContext) {
  const { assignment, contentDirectory } = await makeWorkspace(t)
  let asked = 0
  const store = new FileSystemWorkflowStateStore(assignment, {
    ...storeOptions(), randomUUID: () => (asked++ === 0 ? 'question-one' : 'question-two'),
  })
  await startRunningStep(store)
  return { store, contentDirectory }
}

function secondAgentQuestion(): RequestAgentInput {
  const input = questionInput()
  return {
    ...input, invocation: { ...input.invocation, agentId: 'editor', logicalInvocationId: 'chain-step-two', dispatchId: 'dispatch-two' },
  }
}

test('an identical question from another agent shares the content file and leaves it as saved', async (t) => {
  const { store, contentDirectory } = await makeTwoQuestionStore(t)
  await store.requestAgentInput(questionInput())
  const requestPath = path.join(contentDirectory, fileName('request'))
  const savedFile = await fs.stat(requestPath)

  assert.deepEqual(await store.requestAgentInput(secondAgentQuestion()),
    { kind: 'awaiting_input', interactionId: 'question-two' })
  const interactions = (await store.load())?.state.agentQuestions?.interactions ?? []
  assert.deepEqual(interactions.map((interaction) => interaction.requestContent),
    [STORED.request.reference, STORED.request.reference])
  // The same file, not a replacement written over it.
  assert.equal((await fs.stat(requestPath)).ino, savedFile.ino)
  assert.deepEqual(await fs.readFile(requestPath), Buffer.from(STORED.request.text, 'utf8'))
})

test('an identical question is refused when the file it would share was changed, and the changed file is kept as found', async (t) => {
  const { store, contentDirectory } = await makeTwoQuestionStore(t)
  await store.requestAgentInput(questionInput())
  const requestPath = path.join(contentDirectory, fileName('request'))
  const edited = STORED.request.text.replace('dedication', 'dedicatioN')
  await fs.writeFile(requestPath, edited)

  await assert.rejects(store.requestAgentInput(secondAgentQuestion()),
    { code: 'corrupt', message: 'A saved question content was changed after it was saved.' })
  assert.deepEqual((await store.load())?.state.agentQuestions?.interactions.map((interaction) => interaction.interactionId),
    ['question-one'])
  assert.equal(await fs.readFile(requestPath, 'utf8'), edited)
})

test('a regular file where the content folder belongs is refused with a store error, and nothing changes', async (t) => {
  const { store, contentDirectory } = await makeRunningStore(t)
  await fs.writeFile(contentDirectory, 'not a folder')

  await assert.rejects(store.requestAgentInput(questionInput()),
    { code: 'corrupt', message: 'The question storage is not a folder.' })
  assert.equal(await fs.readFile(contentDirectory, 'utf8'), 'not a folder')
  assert.equal((await store.load())?.state.agentQuestions, undefined)
})

test('a state update is refused when the private runtime folder was moved outside the assignment after the store was opened', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  const runtime = path.join(assignment, '.runtime')
  const outside = path.join(path.dirname(assignment), 'outside-runtime')
  await fs.rename(runtime, outside)
  await fs.symlink(outside, runtime)
  const outsideState = await fs.readFile(path.join(outside, 'workflow-state.json'))
  const outsideEntries = (await fs.readdir(outside)).sort()

  // A valid update that changes nothing but the revision.
  await assert.rejects(store.update({ expectedRevision: 2, executionAttemptId: 'attempt-one', mutate: () => undefined }),
    { code: 'corrupt', message: 'The workflow storage is outside its assignment.' })
  assert.deepEqual(await fs.readFile(path.join(outside, 'workflow-state.json')), outsideState)
  assert.deepEqual((await fs.readdir(outside)).sort(), outsideEntries)
})

test('a question read is refused when the private runtime folder was moved outside the assignment after it was asked', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  await store.requestAgentInput(questionInput())
  const runtime = path.join(assignment, '.runtime')
  const outside = path.join(path.dirname(assignment), 'outside-runtime')
  await fs.rename(runtime, outside)
  await fs.symlink(outside, runtime)

  await assert.rejects(store.readAgentQuestion('question-one'),
    { code: 'corrupt', message: 'The workflow storage is outside its assignment.' })
})

test('a journal-enrolled question read is refused when the private runtime folder was moved outside the assignment', async (t) => {
  // An enrolled assignment answers question reads from its journal and reads
  // the manifest without the workflow lock, so the lock's own check does not
  // cover it.
  const { assignment } = await makeWorkspace(t)
  const journal = await initializeExecutionJournal({
    scopeRoot: assignment,
    identity: {
      scopeKind: 'assignment', scopeId: 'root-one', tenantId: 'local',
      sessionId: 'session-one', runId: 'root-one', assignmentId: 'root-one',
    },
  })
  t.after(() => journal.close())
  const store = new FileSystemWorkflowStateStore(assignment, {
    ...storeOptions(), journal: createJournalBackedWorkflowRecorder(journal),
  })
  await startRunningStep(store)
  await store.requestAgentInput(questionInput())
  const runtime = path.join(assignment, '.runtime')
  const outside = path.join(path.dirname(assignment), 'outside-runtime')
  await fs.rename(runtime, outside)
  await fs.symlink(outside, runtime)

  await assert.rejects(store.readAgentQuestion('question-one'),
    { code: 'corrupt', message: 'The workflow storage is outside its assignment.' })
})

test('the execution manifest is not read through a private runtime folder moved outside the assignment', async (t) => {
  const { store, assignment } = await makeRunningStore(t)
  const runtime = path.join(assignment, '.runtime')
  const outside = path.join(path.dirname(assignment), 'outside-runtime')
  await fs.rename(runtime, outside)
  await fs.symlink(outside, runtime)

  await assert.rejects(store.readExecutionManifest(),
    { code: 'corrupt', message: 'The workflow storage is outside its assignment.' })
})
