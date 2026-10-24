/**
 * The rules a planned Agent's proposal card copy must meet, with nothing else
 * attached.
 *
 * A planned Agent carries two pieces of prose. `summary` is one plain sentence
 * written for the proposal card. `description` is the detailed brief the Agent
 * generator builds the package from, and it has no display limit. This limit
 * applies to the summary alone.
 *
 * It is a validation bound for newly authored proposals, not a model context
 * budget, so it does not belong in `core/context-limits.ts`. The provider
 * schema, the proposal parser, and the response contract the model reads all
 * take it from here. The number itself is defined once in the contracts layer,
 * because the renderer derives card copy for older plans under the same limit
 * and may import nothing but contracts.
 */

export { MAX_PLANNED_AGENT_SUMMARY_LENGTH } from "../../contracts/planned-agent-summary.js";
