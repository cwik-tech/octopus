/**
 * The dispatch rule, re-exported at the path the server has always read it
 * from.
 *
 * The rule itself moved to `contracts/session-dispatch.ts` when the composer
 * had to describe what Send would do: describing it from a copy would have
 * made the interface a second router.
 */

export {
  isUserSelectedWorkflow,
  resolveSessionDispatch,
  type SessionDispatchDecision,
  type SessionMessageTarget,
} from "../../contracts/session-dispatch.js";
