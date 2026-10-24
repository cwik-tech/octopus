import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { measureResourceArchitectPrompt } from "../domains/resource-architect/resource-architect-llm.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const history = [{
  role: "user" as const,
  text: "Hello. Help me decide whether I need an Agent or a Team.",
}];

const measurements = (["conversation", "proposal"] as const).map((operation) =>
  measureResourceArchitectPrompt({ repoRoot, operation, history })
);

console.log(JSON.stringify({ measurements }, null, 2));
