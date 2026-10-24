import { useMemo } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import {
  isThinkingLevel,
  PROVIDER_DEFAULT_THINKING,
  type ThinkingLevel,
} from "@contracts/thinking-levels";

/**
 * How hard a turn thinks when nothing more specific was chosen.
 *
 * The companion to the default model: that one answers which model runs, this
 * one answers how much effort it spends. An Agent whose file names no level
 * follows this setting, and one that names a level keeps it.
 *
 * Two differences from the Agent editor's control, both deliberate:
 *
 * - **No "Application default" entry.** This control *is* the application
 *   default, and an option pointing at itself would say nothing.
 * - **The levels come from the default model.** That pair is what these turns
 *   will run on, so offering anything else would offer a level the turns it
 *   governs cannot use. "Provider default" stays, because "let each provider
 *   decide" is a real answer to this question.
 */
export function DefaultEffortSelect(props: {
  id?: string;
  value: ThinkingLevel | undefined;
  disabled?: boolean;
  onChange: (level: ThinkingLevel) => void;
  className?: string;
}) {
  const { effortCapabilities, defaultModelState } = useProviderCatalog();

  const levels = useMemo(() => {
    const pair =
      defaultModelState.status === "unset"
        ? undefined
        : { provider: defaultModelState.provider, model: defaultModelState.model };
    const reported: ThinkingLevel[] = pair
      ? effortCapabilities.find(
          (entry) => entry.provider === pair.provider && entry.model === pair.model,
        )?.levels ?? []
      : [];
    // The stored level is always shown, so a setting made when the default
    // model was something else stays visible rather than looking unset.
    return props.value &&
      props.value !== PROVIDER_DEFAULT_THINKING &&
      !reported.includes(props.value)
      ? [...reported, props.value]
      : reported;
  }, [effortCapabilities, defaultModelState, props.value]);

  return (
    <Select
      value={props.value ?? null}
      onValueChange={(next) => {
        // The primitive hands back whatever it holds. A level is only a level
        // when this application can express it, and the guard is the same one
        // every other boundary uses.
        if (!isThinkingLevel(next) || next === props.value) return;
        props.onChange(next);
      }}
      disabled={props.disabled ?? false}
    >
      {/* The visible Default effort label names this control through htmlFor. */}
      <SelectTrigger id={props.id ?? "default-effort"} className={props.className}>
        <SelectValue placeholder="Select a default effort">
          {(selected) => {
            if (selected === PROVIDER_DEFAULT_THINKING) return "Provider default";
            return typeof selected === "string" && selected
              ? selected
              : "Select a default effort";
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
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
