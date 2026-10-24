/**
 * The Team editor's writes name the version of the team it loaded.
 *
 * Nothing in the app is mocked. The real panel, hook and clients run against a
 * loopback HTTP server (`team-builder-api-server.ts`) that keeps the backend's
 * revision rule, so each test observes two things only: what reached the
 * network (method, path, and the revision in the JSON body or the DELETE
 * query), and what the panel shows. Behavior that only the desktop app shows
 * is left to the renderer-to-API journey.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TeamArchitectPanelProps } from "../types";
import {
  REVISION_CONFLICT_REASON,
  startTeamBuilderApiServer,
  type RecordedRequest,
  type TeamBuilderApiServer,
} from "./team-builder-api-server";

const TEAM = "furniture-makers";
const LOADED_DESCRIPTION = "A practical woodworking team.";

let api: TeamBuilderApiServer;
let TeamArchitectPanel: ComponentType<TeamArchitectPanelProps>;

beforeAll(async () => {
  api = await startTeamBuilderApiServer();
  // The clients read their API base once, when they are first loaded, so the
  // panel is imported only after the server's address is known.
  sessionStorage.setItem("pipeline.desktop-api-base-url", api.baseUrl);
  TeamArchitectPanel = (await import("../team-architect-panel")).default;
});

afterAll(async () => {
  await api.close();
  sessionStorage.clear();
});

beforeEach(() => {
  api.reset(
    [
      { id: TEAM, description: LOADED_DESCRIPTION, members: ["furniture-making-lead"] },
      { id: "garden-makers", description: "Builds garden furniture.", members: [] },
    ],
    ["furniture-making-lead", "joiner"],
  );
});

afterEach(() => cleanup());

/** Opens a team in the panel and waits until its details are on screen. */
async function openTeam(teamId = TEAM, description = LOADED_DESCRIPTION) {
  const view = render(
    <TeamArchitectPanel detailsOpen teamSelectionRequest={{ id: teamId, requestId: teamId }} />,
  );
  await screen.findByDisplayValue(description);
  return view;
}

/** The revision the server gave when the panel loaded the team. */
function loadedRevision(teamId = TEAM): string {
  const revision = api.team(teamId)?.revision;
  if (!revision) throw new Error(`No revision for ${teamId}`);
  return revision;
}

function writesTo(method: string, path: string): RecordedRequest[] {
  return api.requests.filter((request) => request.method === method && request.path === path);
}

async function typeDescription(from: string, to: string) {
  const field = screen.getByDisplayValue(from);
  await userEvent.clear(field);
  await userEvent.type(field, to);
}

describe("the Team editor writes against the revision it loaded", () => {
  it("saves the details naming the loaded revision in the body", async () => {
    await openTeam();
    const revision = loadedRevision();
    await typeDescription(LOADED_DESCRIPTION, "A careful woodworking team.");

    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const [put] = writesTo("PUT", `/create/team-builder/teams/${TEAM}`);
    expect(put?.body).toMatchObject({
      description: "A careful woodworking team.",
      expectedRevision: revision,
    });
    expect(api.team(TEAM)?.description).toBe("A careful woodworking team.");
  });

  it("deletes the team naming the loaded revision, encoded, in the query", async () => {
    await openTeam();
    const revision = loadedRevision();

    await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete team" }));

    expect(
      await screen.findByText("Select a team in the sidebar to inspect it."),
    ).toBeInTheDocument();
    const [deletion] = writesTo("DELETE", `/create/team-builder/teams/${TEAM}`);
    expect(deletion?.query.get("expectedRevision")).toBe(revision);
    expect(deletion?.rawPathAndQuery).toContain(
      `expectedRevision=${encodeURIComponent(revision)}`,
    );
    expect(api.team(TEAM)).toBeUndefined();
  });

  it("adds a member naming the loaded revision in the body", async () => {
    await openTeam();
    const revision = loadedRevision();

    await userEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "Joiner" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^Add$/ }));

    expect(
      await screen.findByRole("button", { name: "Remove Joiner from team roster" }),
    ).toBeInTheDocument();
    const [addition] = writesTo("POST", `/create/team-builder/teams/${TEAM}/agents`);
    expect(addition?.body).toMatchObject({ agentName: "joiner", expectedRevision: revision });
    expect(api.team(TEAM)?.members).toEqual(["furniture-making-lead", "joiner"]);
  });

  it("removes a member naming the loaded revision, encoded, in the query", async () => {
    await openTeam();
    const revision = loadedRevision();

    await userEvent.click(
      screen.getByRole("button", { name: "Remove Furniture Making Lead from team roster" }),
    );

    await waitFor(() => expect(api.team(TEAM)?.members).toEqual([]));
    const [removal] = writesTo(
      "DELETE",
      `/create/team-builder/teams/${TEAM}/agents/furniture-making-lead`,
    );
    expect(removal?.query.get("expectedRevision")).toBe(revision);
    expect(removal?.rawPathAndQuery).toContain(
      `expectedRevision=${encodeURIComponent(revision)}`,
    );
    expect(
      screen.queryByRole("button", { name: "Remove Furniture Making Lead from team roster" }),
    ).not.toBeInTheDocument();
  });
});

describe("the Team editor when someone else changed the team first", () => {
  it("shows a refused save, the team as it now stands and the typed details, then saves against what it showed", async () => {
    await openTeam();
    await typeDescription(LOADED_DESCRIPTION, "My unsaved description.");
    api.changeElsewhere(TEAM, {
      description: "Changed by someone else.",
      members: ["furniture-making-lead", "joiner"],
    });
    const changedRevision = loadedRevision();

    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(await screen.findByText(REVISION_CONFLICT_REASON)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Joiner from team roster" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("My unsaved description.")).toBeInTheDocument();
    expect(api.team(TEAM)?.description).toBe("Changed by someone else.");

    // Saving again, having seen the change, names the revision the refusal
    // carried; nothing read the team just to pass the check.
    const readsBefore = writesTo("GET", `/create/team-builder/teams/${TEAM}`).length;
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const puts = writesTo("PUT", `/create/team-builder/teams/${TEAM}`);
    expect(puts[1]?.body).toMatchObject({ expectedRevision: changedRevision });
    expect(writesTo("GET", `/create/team-builder/teams/${TEAM}`)).toHaveLength(readsBefore);
    expect(api.team(TEAM)?.description).toBe("My unsaved description.");
  });

  it("shows a refused delete, keeps the team open as it now stands and deletes none of its Agents", async () => {
    await openTeam();
    api.changeElsewhere(TEAM, { description: "Changed by someone else." });

    await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete team and 1 agent" }),
    );

    expect(await screen.findByText(REVISION_CONFLICT_REASON)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Changed by someone else.")).toBeInTheDocument();
    expect(api.team(TEAM)).toBeDefined();
    expect(writesTo("POST", "/create/agents/delete")).toHaveLength(0);
  });

  it("shows a refused member addition and the team as it now stands", async () => {
    await openTeam();
    api.changeElsewhere(TEAM, { description: "Changed by someone else." });

    await userEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "Joiner" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^Add$/ }));

    // Said in the dialog, where the person is, as the dialog does for any
    // refusal.
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(REVISION_CONFLICT_REASON);
    expect(screen.getByDisplayValue("Changed by someone else.")).toBeInTheDocument();
    expect(api.team(TEAM)?.members).toEqual(["furniture-making-lead"]);
  });

  it("shows a refused member removal and the team as it now stands, keeping the typed details", async () => {
    await openTeam();
    await typeDescription(LOADED_DESCRIPTION, "My unsaved description.");
    api.changeElsewhere(TEAM, { members: ["furniture-making-lead", "joiner"] });

    await userEvent.click(
      screen.getByRole("button", { name: "Remove Furniture Making Lead from team roster" }),
    );

    expect(await screen.findByText(REVISION_CONFLICT_REASON)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Joiner from team roster" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("My unsaved description.")).toBeInTheDocument();
    expect(api.team(TEAM)?.members).toEqual(["furniture-making-lead", "joiner"]);
  });

  it("ignores a refusal about a team the person has left", async () => {
    const view = await openTeam();
    await typeDescription(LOADED_DESCRIPTION, "My unsaved description.");
    const held = api.holdNext("PUT");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // The person opens another team while that save is out.
    view.rerender(
      <TeamArchitectPanel
        detailsOpen
        teamSelectionRequest={{ id: "garden-makers", requestId: "garden-makers" }}
      />,
    );
    await screen.findByDisplayValue("Builds garden furniture.");
    const addAgent = screen.getByRole("button", { name: "Add agent" });
    // The save still holds the editor, so the other team's controls wait.
    expect(addAgent).toBeDisabled();

    // Someone else changed the first team, so the held save is refused.
    api.changeElsewhere(TEAM, { description: "Changed by someone else." });
    await act(async () => {
      held.release();
      await held.answered;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add agent" })).toBeEnabled());

    expect(screen.getByDisplayValue("Builds garden furniture.")).toBeInTheDocument();
    expect(screen.queryByText(REVISION_CONFLICT_REASON)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Changed by someone else.")).not.toBeInTheDocument();
  });
});
