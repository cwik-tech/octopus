import { describe, expect, it } from "vitest";

import { getNewActionPresentation } from "@/lib/utils/app-navigation";

describe("getNewActionPresentation", () => {
  it("labels each workspace", () => {
    expect(
      getNewActionPresentation({
        activeTab: "run",
        createTab: "workflows",
        isCreatingSession: false,
      }),
    ).toEqual({ disabled: false, label: "New chat" });
    expect(
      getNewActionPresentation({
        activeTab: "library",
        createTab: "workflows",
        isCreatingSession: false,
      }),
    ).toEqual({ disabled: false, label: "New project" });
  });

  it("names the Library plus action after the selected section", () => {
    expect(getNewActionPresentation({ activeTab: "library", createTab: "agents", isCreatingSession: false, librarySection: "skills" })).toEqual({ disabled: false, label: "New skill" });
    expect(getNewActionPresentation({ activeTab: "library", createTab: "agents", isCreatingSession: false, librarySection: "projects" })).toEqual({ disabled: false, label: "New project" });
  });

  it("offers importing resources from the other Library sections", () => {
    expect(getNewActionPresentation({ activeTab: "library", createTab: "agents", isCreatingSession: false, librarySection: "agents" })).toEqual({ disabled: false, label: "Import resources" });
  });

  it("disables the Library plus until its current dialog action is registered", () => {
    expect(getNewActionPresentation({ activeTab: "library", createTab: "agents", isCreatingSession: false, librarySection: "skills", libraryActionReady: false })).toEqual({ disabled: true, label: "New skill" });
  });

  it("names the new Create item after the active Create tab", () => {
    expect(
      getNewActionPresentation({
        activeTab: "create",
        createTab: "workflows",
        isCreatingSession: false,
      }),
    ).toEqual({ disabled: false, label: "New workflow" });
    expect(
      getNewActionPresentation({
        activeTab: "create",
        createTab: "agents",
        isCreatingSession: false,
      }),
    ).toEqual({ disabled: false, label: "New agent" });
    expect(
      getNewActionPresentation({
        activeTab: "create",
        createTab: "teams",
        isCreatingSession: false,
      }),
    ).toEqual({ disabled: false, label: "New team" });
  });

  it("disables new chat while session creation is pending", () => {
    expect(
      getNewActionPresentation({
        activeTab: "run",
        createTab: "workflows",
        isCreatingSession: true,
      }).disabled,
    ).toBe(true);
  });
});
