import type { HelperModelSelection } from "@/lib/utils/chat-timeline";
import type { RunEvent } from "@/components/run/stage-renderers";

/**
 * The one delegation event that says which model named a job.
 *
 * Written by the routing stage before it asks anything
 * (`engines/spawn-tools.ts`), and published under its own name so a reader does
 * not have to infer it from the presence of a selection.
 */
export const JOB_TITLE_SELECTED_EVENT = "delegation.job_title_selected";

/**
 * The one runtime event that says which model a background helper ran on.
 *
 * Written by the helper itself before it asks anything
 * (`domains/provider/helper-model-selection.ts`), and named the same way and
 * for the same reason.
 */
export const HELPER_MODEL_SELECTED_EVENT = "runtime.helper_model_selected";

/**
 * What each helper is called where a person reads about it.
 *
 * A `Map`, not an object literal: `helper` comes off the wire, and a plain
 * object answers `constructor` or `toString` with something inherited. That is
 * not a name — and the notice's own display helper throws on it, inside the
 * conversation it was meant to appear in.
 */
const HELPER_SPEAKERS: ReadonlyMap<string, string> = new Map([
  ["compression", "context compression"],
  ["minutes", "meeting minutes"],
]);

/**
 * What the application's own helpers ran on, from the run's own records.
 *
 * Three things this deliberately does not do. It does not accept any
 * selection that happens to travel beside one of these events: an agent's or a
 * host's own record can, and reporting one of those would say a model did work
 * it never did. It does not report a helper it has no name for, because "a
 * helper used the app default" is not an account of anything. And it does not
 * trust the stored time — that is a string on the way in and need not be a date
 * at all, so an unreadable one sorts at the epoch rather than throwing inside
 * the conversation, and no time is invented for it.
 */
export function collectHelperModelSelections(
  groups: readonly {
    readonly taskId?: string;
    readonly events: readonly RunEvent[];
  }[],
): HelperModelSelection[] {
  return groups.flatMap((group) =>
    group.events.flatMap((event) => {
      if (!event.modelSelection) return [];
      const at = new Date(
        Number.isFinite(event.ts) ? event.ts : 0,
      ).toISOString();
      if (event.type === JOB_TITLE_SELECTED_EVENT && event.delegationId) {
        return [{
          // Namespaced by what the key identifies. One set deduplicates every
          // kind of notice, so two kinds that key on different things must not
          // be able to produce the same string — a delegation id and a
          // task-and-event pair are unrelated identities, and a collision
          // between them would silently drop a real model use.
          key: `job-title:${event.delegationId}`,
          speaker: "job title",
          selection: event.modelSelection,
          at,
        }];
      }
      if (event.type === HELPER_MODEL_SELECTED_EVENT) {
        const speaker = event.helper
          ? HELPER_SPEAKERS.get(event.helper)
          : undefined;
        // Keyed by the event *within its own task*, not by the helper: a long
        // run legitimately compresses more than once, so keeping only the first
        // would report one model use where there were several. And not by the
        // event id alone — those are per stream, so a second task starts
        // numbering again and its helper turns would be deduplicated away as
        // repeats of the first task's.
        //
        // The run id backs the task up rather than an empty string. A group
        // with no task identity is not "the same group" as every other one, and
        // collapsing them all under `""` would drop a second run's helper turns
        // as repeats of the first's — the exact failure this key exists to
        // prevent, reintroduced by the fallback.
        const scope = group.taskId ?? event.runId ?? "";
        if (speaker) {
          return [{
            key: `helper:${scope}:${event.id}`,
            speaker,
            selection: event.modelSelection,
            at,
          }];
        }
      }
      return [];
    }),
  );
}
