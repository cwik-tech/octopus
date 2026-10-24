import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import type * as http from "node:http";
import * as path from "node:path";
import type { URL } from "node:url";

import { parseYaml } from "../../core/yaml-parser.js";
import { writeJson } from "../http.js";

export async function handleTeamMetadataRoute(params: {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly url: URL;
  readonly repoRootPath?: string;
}): Promise<boolean> {
  const { req, res, url, repoRootPath } = params;
  if (
    req.method !== "GET" ||
    (url.pathname !== "/api/team" && url.pathname !== "/team")
  ) {
    return false;
  }

  const teamYamlPath = repoRootPath
    ? path.join(
        repoRootPath,
        "teams",
        "reception-desk",
        "team.yaml",
      )
    : null;

  if (!teamYamlPath || !existsSync(teamYamlPath)) {
    writeJson(res, 200, { agents: [] });
    return true;
  }

  let rawYaml: string;
  try {
    rawYaml = await fs.readFile(teamYamlPath, "utf8");
  } catch {
    writeJson(res, 200, { agents: [] });
    return true;
  }

  let agentsRaw: unknown;
  try {
    const parsed = parseYaml(rawYaml);
    agentsRaw = parsed.agents;
  } catch {
    writeJson(res, 200, { agents: [] });
    return true;
  }

  if (!Array.isArray(agentsRaw)) {
    writeJson(res, 200, { agents: [] });
    return true;
  }

  const agents = (agentsRaw as unknown[])
    .filter(
      (agent): agent is Record<string, unknown> =>
        typeof agent === "object" &&
        agent !== null &&
        !Array.isArray(agent),
    )
    .map((agent) => ({
      id: typeof agent.name === "string" ? agent.name : "",
      name: typeof agent.name === "string" ? agent.name : "",
      color: agent.color != null ? String(agent.color) : undefined,
    }))
    .filter((agent) => agent.id.length > 0);

  writeJson(res, 200, { agents });
  return true;
}
