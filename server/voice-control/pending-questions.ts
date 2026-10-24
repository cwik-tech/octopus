/**
 * What a task is waiting for a person to do, read through the window's own
 * routes: a workflow's feedback step, an agent's questions, or a model choice.
 */
import * as z from 'zod/v4'

import type { AppMcpToolResult } from './app-mcp-endpoint.js'
import type { LoopbackRestClient } from './loopback-rest-client.js'
import { clip, failure, openingSentences, sessionPath } from './tool-support.js'

const humanInputSchema = z.looseObject({
  workflowRevision: z.number(),
  interaction: z.looseObject({
    interactionId: z.string(),
    status: z.string(),
    sourceArtifact: z.looseObject({ sha256: z.string() }),
  }),
  sourceText: z.string(),
})

const agentQuestionViewSchema = z.looseObject({
  interactionId: z.string(),
  revision: z.number(),
  requestDigest: z.string(),
  questionIds: z.array(z.string()),
  agentDisplayName: z.string().optional(),
  status: z.string(),
  canSubmit: z.boolean(),
  request: z.looseObject({
    questions: z.array(z.looseObject({ question: z.string() })),
  }),
})

const pairSchema = z.looseObject({ provider: z.string(), model: z.string() })
export const modelChoiceSchema = z.looseObject({
  offer: z.looseObject({
    offerId: z.string(),
    agentName: z.string(),
    failedChoice: pairSchema,
    proposedDefault: pairSchema,
    reason: z.string(),
  }),
})

/** What a task is waiting for a person to do, if anything. */
export type PendingQuestion =
  | {
      readonly kind: 'feedback'
      readonly interactionId: string
      readonly workflowRevision: number
      readonly sourceSha256: string
      readonly sourceText: string
    }
  | {
      readonly kind: 'questions'
      readonly interactionId: string
      readonly revision: number
      readonly requestDigest: string
      readonly questionIds: readonly string[]
      readonly questions: readonly string[]
      readonly agentName: string
    }
  | {
      readonly kind: 'model_choice'
      readonly offerId: string
      readonly agentName: string
      readonly failedModel: string
      readonly proposedModel: string
      readonly reason: string
    }
  | { readonly kind: 'none' }

const MODEL_CHOICE_REASONS: Readonly<Record<string, string>> = {
  'missing-credential': 'its key is missing',
  'invalid-credential': 'its key was refused',
  'model-unavailable': 'the model is unavailable',
  'quota-exhausted': 'its quota ran out',
}

/** One question read aloud, and the whole sentence; `notify.speech` allows 2,000. */
const MAX_SPOKEN_QUESTION = 600
const MAX_SPOKEN_SENTENCE = 1_500

/**
 * The sentence that reads a waiting task's question aloud. An agent may ask up
 * to 2,000 characters per question and several questions, so each question and
 * the sentence are cut to a length that can be spoken; the full text stays in
 * `get_question`'s data.
 */
export function pendingQuestionSentence(pending: PendingQuestion): string {
  return clip(fullPendingQuestionSentence(pending), MAX_SPOKEN_SENTENCE)
}

function fullPendingQuestionSentence(pending: PendingQuestion): string {
  switch (pending.kind) {
    case 'feedback':
      return `The workflow wants your feedback on this: ${openingSentences(pending.sourceText)}`
    case 'questions':
      return pending.questions.length === 1
        ? `${pending.agentName} asks: ${clip(pending.questions[0] ?? '', MAX_SPOKEN_QUESTION)}`
        : `${pending.agentName} asks ${pending.questions.length} questions. ${pending.questions
            .map((question, index) => `${index + 1}: ${clip(question, MAX_SPOKEN_QUESTION)}`)
            .join(' ')}`
    case 'model_choice':
      return `${pending.agentName}'s model, ${pending.failedModel}, didn't run because ${
        MODEL_CHOICE_REASONS[pending.reason] ?? pending.reason
      }. Retry it on ${pending.proposedModel}?`
    case 'none':
      return 'Nothing is waiting for your answer.'
  }
}

/**
 * Asks each route that can hold a task waiting for a person, in the order
 * the window shows them: a workflow's feedback step, an agent's question,
 * then a model choice.
 */
export async function findPendingQuestion(
  rest: LoopbackRestClient,
  sessionId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<{ readonly pending: PendingQuestion } | { readonly failure: AppMcpToolResult }> {
  const feedback = await rest.request('GET', sessionPath(sessionId, 'tasks', taskId, 'human-in-the-loop'), { signal })
  if (feedback.status === 200) {
    const parsed = humanInputSchema.safeParse(feedback.body)
    if (parsed.success && parsed.data.interaction.status === 'pending') {
      return {
        pending: {
          kind: 'feedback',
          interactionId: parsed.data.interaction.interactionId,
          workflowRevision: parsed.data.workflowRevision,
          sourceSha256: parsed.data.interaction.sourceArtifact.sha256,
          sourceText: parsed.data.sourceText,
        },
      }
    }
  } else if (feedback.status !== 404 && feedback.status !== 409) {
    return { failure: failure(feedback, 'read the question') }
  }
  const questions = await rest.request('GET', sessionPath(sessionId, 'tasks', taskId, 'agent-questions'), { signal })
  if (questions.status === 200) {
    const parsed = z.array(agentQuestionViewSchema).safeParse(questions.body)
    const open = parsed.success
      ? parsed.data.find((view) => view.canSubmit && view.status === 'pending')
      : undefined
    if (open) {
      return {
        pending: {
          kind: 'questions',
          interactionId: open.interactionId,
          revision: open.revision,
          requestDigest: open.requestDigest,
          questionIds: open.questionIds,
          questions: open.request.questions.map((entry) => entry.question),
          agentName: open.agentDisplayName ?? 'The agent',
        },
      }
    }
  } else if (questions.status !== 404 && questions.status !== 409) {
    return { failure: failure(questions, 'read the question') }
  }
  const choice = await rest.request('GET', sessionPath(sessionId, 'tasks', taskId, 'model-choice'), { signal })
  if (choice.status === 200) {
    const parsed = modelChoiceSchema.safeParse(choice.body)
    if (parsed.success) {
      const offer = parsed.data.offer
      return {
        pending: {
          kind: 'model_choice',
          offerId: offer.offerId,
          agentName: offer.agentName,
          failedModel: offer.failedChoice.model,
          proposedModel: offer.proposedDefault.model,
          reason: offer.reason,
        },
      }
    }
  } else if (choice.status !== 404 && choice.status !== 409) {
    return { failure: failure(choice, 'read the question') }
  }
  return { pending: { kind: 'none' } }
}
