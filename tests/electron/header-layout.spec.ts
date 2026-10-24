import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { fixtureDesktopEnvironment } from "../support/desktop-journey-environment.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("header navigation and actions stay aligned across Run workspace states", async ({}, testInfo) => {
  const userDataPath = testInfo.outputPath("header-layout-user-data");
  await fs.mkdir(userDataPath, { recursive: true });

  const app = await launchDesktop(userDataPath);
  const page = await app.firstWindow();

  try {
    await verifyVerticallyCenteredNavigation(page);
    await verifyRunSidebarPlacement(page);
    await verifyStableHeaderActions(page);
    await verifyClosedWorkspaceGutter(page);
    await verifyQueueHeaderNavigation(page);
  } finally {
    await app.close();
  }
});

async function launchDesktop(userDataPath: string): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  return electron.launch({
    args: executablePath
      ? ["--disable-gpu", "--no-sandbox"]
      : [".", "--disable-gpu", "--no-sandbox"],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: "1",
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  });
}

async function verifyRunSidebarPlacement(page: Page): Promise<void> {
  const leftSidebar = page.locator(
    '[data-slot="workspace-sidebar"][data-side="left"]',
  );
  const rightSidebar = page.locator(
    '[data-slot="workspace-sidebar"][data-side="right"]',
  );
  await expect(leftSidebar.locator(".desktop-sidebar-scroll").first()).toHaveCSS(
    "padding-left",
    "8px",
  );
  await expect(rightSidebar).toHaveAttribute("aria-hidden", "true");
  await leftSidebar.getByRole("tab", { name: "Agents", exact: true }).click();
  const runActivity = leftSidebar.locator('[aria-label="Run activity"]');
  await expect(runActivity).toBeVisible();
  await expect(
    leftSidebar.getByRole("heading", { name: "Select Agents" }),
  ).toHaveCount(0);
  await expect(
    leftSidebar.getByRole("button", { name: "Search Run sidebar" }),
  ).toBeVisible();
  await expect(
    leftSidebar.getByText("No agents selected. Chat uses AI Assistant."),
  ).toHaveCount(0);

  await leftSidebar
    .getByRole("tab", { name: "Workflows", exact: true })
    .click();
  const workflowHeading = leftSidebar.getByRole("heading", {
    name: "Workflow Templates",
  });
  await expect(workflowHeading).toBeVisible();
  await expect(workflowHeading.locator("svg")).toHaveCount(0);

  await leftSidebar.getByRole("tab", { name: "Sessions", exact: true }).click();
}

async function verifyStableHeaderActions(page: Page): Promise<void> {
  const leftActions = page.getByRole("group", { name: "Left window actions" });
  const rightActions = page.getByRole("group", { name: "Right window actions" });
  await expect(leftActions).toBeVisible();
  await expect(rightActions).toBeVisible();
  await expect.poll(() => appRegion(leftActions)).toBe("no-drag");
  await expect.poll(() => appRegion(rightActions)).toBe("no-drag");
  expect(await dragRegionsOverlappingButtons(leftActions)).toEqual([]);
  expect(await dragRegionsOverlappingButtons(rightActions)).toEqual([]);
  expect(await horizontalGaps(leftActions)).toEqual([4]);
  expect(await horizontalGaps(rightActions)).toEqual([4]);

  const leftPositions = await toggleAndSampleX(
    page,
    "Left window actions",
    "Hide sidebar",
  );
  expect(positionRange(leftPositions)).toBeLessThanOrEqual(0.1);
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();

  await page.getByRole("tab", { name: "Create", exact: true }).click();
  const rightPositions = await toggleAndSampleX(
    page,
    "Right window actions",
    "Hide details",
  );
  expect(positionRange(rightPositions)).toBeLessThanOrEqual(0.1);
  await expect(page.getByRole("button", { name: "Show details" })).toBeVisible();
  await page.getByRole("tab", { name: "Run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show inspector" })).toHaveCount(0);

  const leftSidebar = page.locator(
    '[data-slot="workspace-sidebar"][data-side="left"]',
  );
  const rightSidebar = page.locator(
    '[data-slot="workspace-sidebar"][data-side="right"]',
  );
  await expect(leftSidebar).toHaveAttribute("aria-hidden", "true");
  await expect(rightSidebar).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => renderedWidth(leftSidebar)).toBe(0);
  await expect.poll(() => renderedWidth(rightSidebar)).toBe(0);
}

async function verifyVerticallyCenteredNavigation(page: Page): Promise<void> {
  const header = page.locator("header.desktop-titlebar");
  const primaryTabs = header.locator('[data-slot="tabs-list"]');
  const runTargetTabs = page.getByRole("tablist", { name: "Run navigation" });

  // The run mode moved out of the header into the run target sidebar.
  await expect(
    page.getByRole("tablist", { name: "Run mode" }),
  ).toHaveCount(0);
  await expect(runTargetTabs).toBeVisible();
  for (const name of ["Sessions", "Teams", "Agents", "Workflows"]) {
    await expect(
      runTargetTabs.getByRole("tab", { name, exact: true }),
    ).toBeVisible();
  }
  for (const name of ["Run", "Create"]) {
    await expect(
      primaryTabs.getByRole("tab", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(
    primaryTabs.getByRole("tab", { name: "Admin", exact: true }),
  ).toHaveCount(0);
  expect(
    Math.abs(await verticalCenterOffset(header, primaryTabs)),
  ).toBeLessThanOrEqual(0.1);

  await page.getByRole("tab", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("tablist", { name: "Create mode" }),
  ).toHaveCount(0);
  const showSidebar = page.getByRole("button", { name: "Show sidebar" });
  if (await showSidebar.isVisible()) await showSidebar.click();
  const resourceTabs = page.getByRole("tablist", { name: "Resource type" });
  await expect(resourceTabs).toBeVisible();
  for (const name of ["Agents", "Teams", "Workflows"]) {
    await expect(
      resourceTabs.getByRole("tab", { name, exact: true }),
    ).toBeVisible();
  }
  expect(
    Math.abs(await verticalCenterOffset(header, primaryTabs)),
  ).toBeLessThanOrEqual(0.1);

  await page.getByRole("tab", { name: "Run", exact: true }).click();
  await expect(runTargetTabs).toBeVisible();
}

async function verifyQueueHeaderNavigation(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await page.getByRole("button", { name: /Queue overview/ }).click();
  await expect(
    page.getByRole("heading", { name: "Queue overview" }),
  ).toBeVisible();

  const tabs = page.getByRole("tablist", { name: "Run navigation" });
  await expect(tabs.getByRole("tab", { name: "Sessions", exact: true })).toBeEnabled();
  await expect(tabs.getByRole("tab", { name: "Teams", exact: true })).toBeDisabled();
}

async function verifyClosedWorkspaceGutter(page: Page): Promise<void> {
  const runChat = page.getByRole("region", { name: "Run chat" });
  await expect(runChat).toBeVisible();
  const chatBounds = await runChat.boundingBox();
  expect(chatBounds).not.toBeNull();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(viewportWidth - (chatBounds!.x + chatBounds!.width)).toBeCloseTo(24, 0);
}

async function horizontalGaps(group: Locator): Promise<number[]> {
  const boxes = await group.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right };
    }),
  );

  return boxes.slice(1).map((box, index) => {
    // `index` runs over the buttons before this one, so the previous button
    // always exists; this never throws.
    const previous = boxes[index];
    if (!previous) throw new Error("A header button has no previous button.");
    return box.left - previous.right;
  });
}

async function appRegion(group: Locator): Promise<string> {
  return group.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("-webkit-app-region"),
  );
}

// Electron resolves overlapping -webkit-app-region rects as a flat
// document-order list (last one wins), ignoring z-index. A drag strip that
// follows a header button in the DOM therefore re-covers the button's no-drag
// hole and swallows physical clicks as window drags. Assert every drag region
// overlapping a button precedes it in document order.
async function dragRegionsOverlappingButtons(group: Locator): Promise<string[]> {
  return group.evaluate((element) => {
    const buttons = [...element.querySelectorAll("button")];
    return buttons.flatMap((button) => {
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return [...document.querySelectorAll("*")]
        .filter((node) => {
          if (node === button || node.contains(button) || button.contains(node))
            return false;
          const region =
            getComputedStyle(node).getPropertyValue("-webkit-app-region");
          if (region !== "drag") return false;
          const bounds = node.getBoundingClientRect();
          return (
            x >= bounds.left &&
            x <= bounds.right &&
            y >= bounds.top &&
            y <= bounds.bottom
          );
        })
        .filter(
          (node) =>
            (button.compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_PRECEDING) ===
            0,
        )
        .map(
          (node) =>
            `${button.getAttribute("aria-label")} overlapped by ${node.tagName.toLowerCase()}`,
        );
    });
  });
}

async function renderedWidth(element: Locator): Promise<number> {
  return element.evaluate((node) => node.getBoundingClientRect().width);
}

async function verticalCenterOffset(
  container: Locator,
  element: Locator,
): Promise<number> {
  const containerBox = await container.boundingBox();
  const elementBox = await element.boundingBox();
  expect(containerBox).not.toBeNull();
  expect(elementBox).not.toBeNull();
  return (
    elementBox!.y + elementBox!.height / 2 -
    (containerBox!.y + containerBox!.height / 2)
  );
}

async function toggleAndSampleX(
  page: Page,
  groupLabel: string,
  buttonLabel: string,
): Promise<number[]> {
  const group = page.getByRole("group", { name: groupLabel });
  await group.getByRole("button", { name: buttonLabel }).click();

  return group.evaluate(
    async (element) => {
      const positions: number[] = [];
      for (let frame = 0; frame < 25; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        positions.push(element.getBoundingClientRect().x);
      }
      return positions;
    },
  );
}

function positionRange(positions: number[]): number {
  return Math.max(...positions) - Math.min(...positions);
}
