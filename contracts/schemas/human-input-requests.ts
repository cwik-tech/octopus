import * as z from 'zod/v4'

import {
  MAX_HUMAN_INPUT_MESSAGES,
  MAX_HUMAN_INPUT_RECIPIENTS_PER_MESSAGE,
  MAX_HUMAN_INPUT_TOTAL_CHARACTERS,
} from '../human-input.js'

const identifierSchema = z
  .string({ error: 'Identifier fields must be strings' })
  .trim()
  .min(1, { error: 'Identifier fields must not be empty' })
  .max(200, { error: 'Identifier fields exceed 200 characters' })

const messageSchema = z.object({
  id: identifierSchema,
  text: z
    .string({ error: 'Human-input message text must be a string' })
    .refine((value) => value.trim().length > 0, {
      error: 'Human-input message text must not be empty',
    }),
  recipients: z.union([
    z.literal('all'),
    z.array(identifierSchema, {
      error: 'Human-input message recipients must be an array or all',
    })
      .min(1, { error: 'Human-input message recipients must not be empty' })
      .max(MAX_HUMAN_INPUT_RECIPIENTS_PER_MESSAGE, {
        error: `Human-input messages support at most ${MAX_HUMAN_INPUT_RECIPIENTS_PER_MESSAGE} recipients`,
      }),
  ]),
}, { error: 'Human-input messages must be objects' })

export const humanInputSubmissionRequestSchema = z.object({
  submissionId: identifierSchema,
  expectedWorkflowRevision: z
    .number({ error: 'expectedWorkflowRevision must be a number' })
    .int({ error: 'expectedWorkflowRevision must be an integer' })
    .nonnegative({ error: 'expectedWorkflowRevision must not be negative' }),
  expectedSourceArtifactSha256: z
    .string({ error: 'expectedSourceArtifactSha256 must be a string' })
    .regex(/^[a-f0-9]{64}$/, {
      error: 'expectedSourceArtifactSha256 must be a lowercase SHA-256 hash',
    }),
  mode: z.enum(['feedback', 'continue_without_feedback'], {
    error: 'mode must be feedback or continue_without_feedback',
  }),
  messages: z.array(messageSchema, {
    error: 'messages must be an array',
  }).max(MAX_HUMAN_INPUT_MESSAGES, {
    error: `Human-input submissions support at most ${MAX_HUMAN_INPUT_MESSAGES} messages`,
  }),
}, { error: 'Request body must be a JSON object' }).superRefine((value, context) => {
  if (value.mode === 'continue_without_feedback' && value.messages.length !== 0) {
    context.addIssue({
      code: 'custom',
      message: 'Continue-without-feedback submissions cannot contain messages',
      path: ['messages'],
    })
  }
  const totalCharacters = value.messages.reduce((total, message) => total + message.text.length, 0)
  if (totalCharacters > MAX_HUMAN_INPUT_TOTAL_CHARACTERS) {
    context.addIssue({
      code: 'custom',
      message: `Human-input submissions support at most ${MAX_HUMAN_INPUT_TOTAL_CHARACTERS} characters`,
      path: ['messages'],
    })
  }
  for (const [index, message] of value.messages.entries()) {
    if (message.recipients === 'all') continue
    if (new Set(message.recipients).size !== message.recipients.length) {
      context.addIssue({
        code: 'custom',
        message: 'Human-input message recipients cannot contain duplicates',
        path: ['messages', index, 'recipients'],
      })
    }
  }
})

export type HumanInputSubmissionRequest = z.infer<
  typeof humanInputSubmissionRequestSchema
>
