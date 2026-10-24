import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import WorkflowMetadataCard from "@/components/create/workflow-metadata-card";
import type { WorkflowDraft } from "@/lib/models/workflow-generator-model";

function yamlLines(...lines: string[]): string {
  return lines.join("\n");
}

function renderCard(yaml: string) {
  // The save never settles, so the card makes no state updates after the
  // click. Each test reads the YAML the card sent.
  const onMetadataSave = vi.fn<(nextYaml: string) => Promise<void>>(
    () => new Promise<void>(() => undefined),
  );
  render(<WorkflowMetadataCard yaml={yaml} onMetadataSave={onMetadataSave} />);
  return { onMetadataSave };
}

function saveName(value: string) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Save workflow name" }));
}

function saveDescription(value: string) {
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save workflow description" }),
  );
}

const singleLineWorkflow = yamlLines(
  "workflow:",
  "  id: research-brief",
  "  description: 'Summarise: the sources'",
  "  steps:",
  "    - id: gather",
  "      agent: researcher",
);

const foldedDescriptionWorkflow = yamlLines(
  "workflow:",
  "  id: research-brief",
  "  description: >",
  "    Gather the sources",
  "    and write a brief.",
  "  on_failed: stop",
  "  steps: []",
);

describe("WorkflowMetadataCard reading workflow properties", () => {
  it("shows the workflow id and a quoted one-line description, not a step's id", () => {
    renderCard(singleLineWorkflow);

    expect(screen.getByLabelText("Name")).toHaveValue("research-brief");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Summarise: the sources",
    );
  });

  it("joins a folded description into one line and stops at the next workflow property", () => {
    renderCard(foldedDescriptionWorkflow);

    expect(screen.getByLabelText("Description")).toHaveValue(
      "Gather the sources and write a brief.",
    );
  });

  it("keeps the line breaks of a literal description, including a blank line inside it", () => {
    renderCard(
      yamlLines(
        "workflow:",
        "  id: research-brief",
        "  description: |",
        "    First paragraph.",
        "",
        "    Second paragraph.",
        "  on_failed: stop",
      ),
    );

    expect(screen.getByLabelText("Description")).toHaveValue(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  it("reads a literal description that runs to the end of the file", () => {
    renderCard(
      yamlLines(
        "workflow:",
        "  id: research-brief",
        "  description: |-",
        "    line one",
        "    line two",
      ),
    );

    expect(screen.getByLabelText("Description")).toHaveValue(
      "line one\nline two",
    );
  });

  it("shows the draft's output and failure policy when a draft is passed", () => {
    const draft: WorkflowDraft = {
      id: "research-brief",
      description: "Summarise the sources",
      input: { artifact: "inputs/request.md" },
      steps: [],
      output: { from_step: "write", artifact: "outputs/research_brief.md" },
      on_blocked: "escalate_to_user",
      on_failed: "stop",
    };
    render(
      <WorkflowMetadataCard
        draft={draft}
        yaml={singleLineWorkflow}
        onMetadataSave={vi.fn<(nextYaml: string) => Promise<void>>()}
      />,
    );

    expect(screen.getByText("Research Brief")).toBeInTheDocument();
    expect(
      screen.getByText("Blocked: Escalate To User; Failed: Stop"),
    ).toBeInTheDocument();
  });

  it("shows empty fields when the workflow block has no id or description of its own", () => {
    renderCard(
      yamlLines(
        "workflow:",
        "  steps:",
        "    - id: gather",
        "      description: Collect notes",
      ),
    );

    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Description")).toHaveValue("");
  });
});

describe("WorkflowMetadataCard saving workflow properties", () => {
  it("saving a new name rewrites only the workflow id line", () => {
    const { onMetadataSave } = renderCard(singleLineWorkflow);

    saveName("market-scan");

    expect(onMetadataSave).toHaveBeenCalledExactlyOnceWith(
      yamlLines(
        "workflow:",
        "  id: market-scan",
        "  description: 'Summarise: the sources'",
        "  steps:",
        "    - id: gather",
        "      agent: researcher",
      ),
    );
  });

  it("saving a description replaces a folded block and its indented lines, keeping the properties after it", () => {
    const { onMetadataSave } = renderCard(foldedDescriptionWorkflow);

    saveDescription("Short summary");

    expect(onMetadataSave).toHaveBeenCalledExactlyOnceWith(
      yamlLines(
        "workflow:",
        "  id: research-brief",
        "  description: Short summary",
        "  on_failed: stop",
        "  steps: []",
      ),
    );
  });

  it("saving a description replaces a literal block through its blank line to the end of the file", () => {
    const { onMetadataSave } = renderCard(
      yamlLines(
        "workflow:",
        "  id: research-brief",
        "  description: |-",
        "    First paragraph.",
        "",
        "    Second paragraph.",
      ),
    );

    saveDescription("One line.");

    expect(onMetadataSave).toHaveBeenCalledExactlyOnceWith(
      yamlLines(
        "workflow:",
        "  id: research-brief",
        "  description: One line.",
      ),
    );
  });

  it("saving a description the workflow lacks inserts it after the id and leaves a step's description alone", () => {
    const { onMetadataSave } = renderCard(
      yamlLines(
        "workflow:",
        "  id: research-brief",
        "  steps:",
        "    - id: gather",
        "      description: Collect notes",
      ),
    );

    saveDescription("Short text");

    expect(onMetadataSave).toHaveBeenCalledExactlyOnceWith(
      yamlLines(
        "workflow:",
        "  id: research-brief",
        "  description: Short text",
        "  steps:",
        "    - id: gather",
        "      description: Collect notes",
      ),
    );
  });

  it("saving a name the workflow lacks inserts the id as the first workflow property", () => {
    const { onMetadataSave } = renderCard(
      yamlLines(
        "workflow:",
        "  description: Collect notes",
        "  steps: []",
      ),
    );

    saveName("market-scan");

    expect(onMetadataSave).toHaveBeenCalledExactlyOnceWith(
      yamlLines(
        "workflow:",
        "  id: market-scan",
        "  description: Collect notes",
        "  steps: []",
      ),
    );
  });
});
