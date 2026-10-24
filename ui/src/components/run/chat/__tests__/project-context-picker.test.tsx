import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { ProjectContextPicker } from "@/components/run/chat/project-context-picker";

type FetchMock = (input: string, init?: RequestInit) => Promise<Response>;

const projectId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.restoreAllMocks();
});

test("project context picker starts empty and applies only checked references", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async (url) =>
      url.endsWith("/brief")
        ? new Response(
            JSON.stringify({
              content: "Stable project brief",
              updatedAt: "2026-08-04T12:00:00.000Z",
            }),
          )
        : new Response(
            JSON.stringify({
              files: [
                {
                  name: "selected.md",
                  size: 10,
                  uploadedAt: "2026-08-04T12:00:00.000Z",
                  parseStatus: "parsed",
                },
                {
                  name: "optional.csv",
                  size: 20,
                  uploadedAt: "2026-08-04T12:00:00.000Z",
                  parseStatus: "parsed",
                },
              ],
            }),
          ),
    ),
  );
  const onChange = vi.fn();
  const user = userEvent.setup();

  render(
    <ProjectContextPicker
      projectId={projectId}
      value={undefined}
      onChange={onChange}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Add project context" }));
  await user.click(await screen.findByRole("checkbox", { name: "Project brief" }));
  await user.click(screen.getByRole("checkbox", { name: "selected.md" }));
  await user.click(screen.getByRole("button", { name: "Apply project context" }));

  expect(onChange).toHaveBeenCalledWith({
    projectId,
    includeBrief: true,
    fileNames: ["selected.md"],
  });
});
