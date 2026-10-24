import { useMemo } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import { PROVIDER_DEFAULT_THINKING } from "@contracts/thinking-levels";
import {
  applyPersonaEffort,
  parsePersonaEffort,
  parsePersonaModelMode,
} from "./persona-frontmatter";

/** The value that stands for "store nothing", which is not a level. */
const APPLICATION_DEFAULT = "__app_default__";

/**
 * How much effort this agent's turns run at.
 *
 * Three kinds of answer, and they are genuinely different things rather than
 * points on one scale:
 *
 * - **A level.** Written into the agent's own file, so it survives a change to
 *   the application default and travels with the agent when it is shared.
 * - **The application default.** Stored as the *absence* of the field, the same
 *   way the model control stores default mode. A copy taken today would stop
 *   following the setting tomorrow, and nothing on screen would say so.
 * - **The provider's own default.** An explicit request to send no effort
 *   setting at all and let the vendor decide, which is not the same as this
 *   application's default and has to be written to happen.
 *
 * The levels offered are the ones the selected provider and model report. Where
 * nothing is known about a pair, no levels are offered — an invented list would
 * be a menu of choices nothing has established, and picking one would stop the
 * turn at dispatch rather than at the moment of choosing.
 */
export function AgentEffortSelect(props: {
  personaMarkdown: string;
  onPersonaChange: (value: string) => void;
  className?: string;
}) {
  const { effortCapabilities, defaultModelState } = useProviderCatalog();
  const stored = parsePersonaEffort(props.personaMarkdown);

  const pair = useMemo(() => {
    const choice = parsePersonaModelMode(props.personaMarkdown);
    if (choice.mode === "explicit") {
      return { provider: choice.provider, model: choice.model };
    }
    if (choice.mode === "invalid") {
      return { provider: choice.provider ?? "", model: choice.model ?? "" };
    }
    return defaultModelState.status === "unset"
      ? { provider: "", model: "" }
      : { provider: defaultModelState.provider, model: defaultModelState.model };
  }, [props.personaMarkdown, defaultModelState]);

  const levels = useMemo(() => {
    // Read from the capability list rather than from the catalogue groups. An
    // Agent may name a built-in API provider, which is in no group at all, and
    // a Claude Code alias has a documented range its catalogue entry does not
    // carry. Both showed an empty menu while this looked in the groups.
    const reported =
      effortCapabilities.find(
        (entry) => entry.provider === pair.provider && entry.model === pair.model,
      )?.levels ?? [];
    // A level the file already names is always shown, even when the pair no
    // longer reports it. Dropping it would display the agent as inheriting the
    // application default while its file says something else.
    const names: string[] = reported;
    return stored &&
      stored !== PROVIDER_DEFAULT_THINKING &&
      !names.includes(stored)
      ? [...names, stored]
      : names;
  }, [effortCapabilities, pair.provider, pair.model, stored]);

  const value = stored ?? APPLICATION_DEFAULT;

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === value) return;
        props.onPersonaChange(
          applyPersonaEffort(
            props.personaMarkdown,
            next === APPLICATION_DEFAULT ? null : next,
          ),
        );
      }}
    >
      <SelectTrigger className={props.className} aria-label="Agent effort">
        <SelectValue>
          {(selected) => {
            if (selected === APPLICATION_DEFAULT || !selected) {
              return "Application default";
            }
            if (selected === PROVIDER_DEFAULT_THINKING) return "Provider default";
            return typeof selected === "string" ? selected : "Application default";
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectItem value={APPLICATION_DEFAULT}>Application default</SelectItem>
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {level}
          </SelectItem>
        ))}
        <SelectItem value={PROVIDER_DEFAULT_THINKING}>Provider default</SelectItem>
      </SelectContent>
    </Select>
  );
}
