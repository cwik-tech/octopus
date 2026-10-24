import { z } from "zod";

const turnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string().datetime().optional(),
});

export const resourceArchitectConversationSchema = z.object({
  schemaVersion: z.literal(1),
  draftId: z.string().min(1),
  history: z.array(turnSchema),
  planId: z.string().min(1).nullable(),
  buildJobId: z.string().min(1).nullable().default(null),
  selectedResource: z.object({ kind: z.enum(["agent", "team"]), id: z.string().min(1) }).nullable(),
  documentReader: z.object({ provider: z.string(), model: z.string() }).nullable(),
  updatedAt: z.string().datetime(),
  turn: z.object({
    jobId: z.string().min(1),
    operation: z.enum(["conversation", "proposal"]),
    status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
  }),
});

export type ResourceArchitectConversation = z.infer<typeof resourceArchitectConversationSchema>;

/**
 * One turn of the saved Create conversation.
 *
 * `createdAt` is assigned by the conversation store when the turn is admitted.
 * The public chat request never carries it.
 */
export type ResourceArchitectTranscriptTurn = ResourceArchitectConversation["history"][number];
