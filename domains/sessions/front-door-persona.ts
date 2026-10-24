/**
 * Reading the front door's persona off disk.
 *
 * Apart from `front-door.ts`, which is pure, because two callers need the file
 * and neither should own the path: the Run chat default reads its provider and
 * model, and the planning turn reads its rules. One place knows where the
 * persona lives.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { extractPlanningRules, GENERAL_AGENT_NAME } from "./front-door.js";

/** Where this repository's front-door persona would be, installed or not. */
export function frontDoorPersonaPath(repoRootPath: string): string {
  return path.join(
    repoRootPath,
    "agents",
    GENERAL_AGENT_NAME,
    `${GENERAL_AGENT_NAME}.md`,
  );
}

/**
 * The persona's frontmatter fields, or `undefined` where there is no persona.
 *
 * Read rather than cached: editing the General Agent in Create is meant to
 * change the next turn, and a cache would make that a restart away.
 */
export function readFrontDoorPersona(
  repoRootPath: string | undefined,
): string | undefined {
  if (!repoRootPath) return undefined;
  try {
    return fs.readFileSync(frontDoorPersonaPath(repoRootPath), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The planning rules this repository's front door states, if it states any.
 *
 * `undefined` where there is no persona or no `## Planning mode` section, and
 * the planning turn then keeps its built-in rules.
 */
export function readFrontDoorPlanningRules(
  repoRootPath: string | undefined,
): string | undefined {
  const persona = readFrontDoorPersona(repoRootPath);
  return persona === undefined ? undefined : extractPlanningRules(persona);
}
