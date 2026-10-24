import { readAgentModelChoice } from "../contracts/agent-model-selection.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../core/constants.js";
import { RECEPTIONIST_DEFAULT } from "../domains/sessions/chat-llm.js";
import {
  frontDoorPersonaPath,
  readFrontDoorPersona,
} from "../domains/sessions/front-door-persona.js";
import { parseAgentFrontmatter } from "../parsers/load-agent.js";
import {
  loadResourceArchitectConfig,
  ResourceArchitectNotConfiguredError,
} from "../domains/resource-architect/resource-architect-prompt.js";
import {
  loadArchitectConfig,
  WorkflowArchitectNotConfiguredError,
} from "../domains/provider/architect-model-config.js";

export interface ChatModelDefault {
  provider: string;
  model: string;
}

export interface ChatDefaults {
  workflow: ChatModelDefault;
  team: ChatModelDefault;
  agent: ChatModelDefault;
  run: ChatModelDefault;
  /**
   * Whether this repository ships the front door's persona.
   *
   * The composer's caption names whoever will answer, and on a deployment
   * without the persona that is the Coordinator. Without this the renderer
   * assumed a front door that is not there.
   */
  frontDoorInstalled: boolean;
}

const SYSTEM_DEFAULT: ChatModelDefault = {
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
};

export function getChatDefaults(
  repoRootPath: string,
  globalDefault?: ChatModelDefault | null,
  options?: {
    /**
     * Whether `globalDefault` is the user's decision or the provider layer's.
     *
     * The provider snapshot fabricates a default from the first model in the
     * catalog when nothing is stored, so on any machine with an enabled
     * provider this argument is present whether or not anybody chose it.
     * Absent reads as `"stored"`, which is the older callers' behaviour.
     */
    globalDefaultSource?: "stored" | "automatic" | "none";
  },
): ChatDefaults {
  const frontDoorInstalled = readFrontDoorPersona(repoRootPath) !== undefined;
  if (globalDefault) {
    const automatic = options?.globalDefaultSource === "automatic";
    // Only the Run surface has a persona of its own to prefer, and only a
    // default nobody chose loses to it. A stored selection is a decision the
    // user made in Settings and outranks every surface's own default, exactly
    // as it did before the front door existed.
    const frontDoor = automatic
      ? readFrontDoorDefault(repoRootPath, { fallback: globalDefault })
      : globalDefault;
    return {
      workflow: globalDefault,
      agent: globalDefault,
      team: globalDefault,
      run: frontDoor,
      frontDoorInstalled,
    };
  }
  const workflow = readWorkflowArchitectDefault(repoRootPath);
  return {
    workflow,
    agent: workflow,
    team: readResourceArchitectDefault(repoRootPath),
    run: readFrontDoorDefault(repoRootPath),
    frontDoorInstalled,
  };
}

/**
 * What the Run composer's model control starts on.
 *
 * The composer sends a provider and model on every turn, seeded from this. If
 * this ignored the front door's persona, "the persona file supplies the
 * default" would be false in the only place a user can see: editing the
 * General Agent's model in Create would change a value nothing ever sent.
 *
 * The persona is read through `readAgentModelChoice`, the same arbiter every
 * other reader of an Agent's frontmatter uses, rather than by taking the two
 * fields literally. Only that function can tell a pair somebody chose from the
 * spellings that mean "nothing chosen": the shipped front door declares
 * `codex`/`default`, which is this repository's sentinel for exactly that, and
 * a persona that omits the provider means it too. Read raw, both were handed
 * to the composer as a deliberate-looking selection, which then overrode the
 * default the user had actually configured and was recorded afterwards as the
 * front door's own choice.
 *
 * The Coordinator's default is the fallback, because a deployment without the
 * persona still answers untargeted turns with the Coordinator.
 */
function readFrontDoorDefault(
  repoRootPath: string,
  options?: { fallback?: ChatModelDefault },
): ChatModelDefault {
  // What a persona that chooses nothing inherits, and what a deployment
  // without the persona keeps. The Coordinator's default where there is
  // nothing else, or the provider layer's automatic pick when that is what
  // this call was preferring the persona over: taking the Coordinator's there
  // would move the model on a machine that has no front door at all, which is
  // not this rule's business.
  const fallback = options?.fallback ?? RECEPTIONIST_DEFAULT;
  const personaPath = frontDoorPersonaPath(repoRootPath);
  try {
    const { frontmatter } = parseAgentFrontmatter(personaPath);
    const { choice } = readAgentModelChoice({
      provider: frontmatter.provider,
      model: frontmatter.model,
    });
    // A reading with no choice is a half-declared pair the contract refuses to
    // complete. Pairing its one stated field with the other half of the
    // fallback would send a combination nobody wrote, so the whole fallback
    // stands.
    if (choice?.mode !== "explicit") return fallback;
    return { provider: choice.provider, model: choice.model };
  } catch {
    return fallback;
  }
}

function readWorkflowArchitectDefault(repoRootPath: string): ChatModelDefault {
  try {
    const config = loadArchitectConfig(repoRootPath);
    return { provider: config.provider, model: config.model };
  } catch (error) {
    if (error instanceof WorkflowArchitectNotConfiguredError) {
      return SYSTEM_DEFAULT;
    }
    throw error;
  }
}

function readResourceArchitectDefault(repoRootPath: string): ChatModelDefault {
  try {
    const config = loadResourceArchitectConfig(repoRootPath);
    return { provider: config.provider, model: config.model };
  } catch (error) {
    if (error instanceof ResourceArchitectNotConfiguredError) {
      return SYSTEM_DEFAULT;
    }
    throw error;
  }
}
