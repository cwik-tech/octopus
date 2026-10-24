/**
 * The Run front door's identity, shared by the server and the interface.
 *
 * In `contracts/` because both sides name it: the server publishes replies
 * under it and the renderer labels them with it, and two spellings of one
 * identity is how a conversation ends up looking like two.
 */

/** The durable identifier, and the folder the persona lives in. */
export const GENERAL_AGENT_NAME = 'general-agent'

/**
 * What the interface calls it.
 *
 * Never a durable identifier. Renaming this changes what a reader sees and
 * nothing that is stored, which is the point.
 */
export const GENERAL_AGENT_LABEL = 'General Agent'
