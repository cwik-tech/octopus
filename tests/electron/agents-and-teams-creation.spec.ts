import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { fixtureDesktopEnvironment } from "../support/desktop-journey-environment.js";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { resourceArchitectConversationSchema } from "../../contracts/schemas/resource-architect-conversation.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const plannedNames = [
  "michigan-contract-lawyer",
  "commercial-risk-lawyer",
  "drafting-completeness-lawyer",
];
const desktopWindowTimeoutMs = 45_000;
const UPDATE_TEAM_ID = "contract-review-team";
const UPDATE_SEEDED_AGENT = "michigan-contract-lawyer";
const UPDATE_LIBRARY_AGENT = "scoping-lawyer";
const UPDATE_NEW_AGENT = "drafting-completeness-lawyer";
const CREATED_TEAM_NEW_AGENT = "regulatory-change-lawyer";
const UPDATE_CUSTOM_MARKER = "CUSTOM-ESCALATION-CONTRACT";
const SKILL_AGENT = "michigan-contract-lawyer";
const SKILL_EXISTING = "indemnity-clause-review";
const SKILL_NEW = "termination-clause-review";
const SKILL_ORIGINAL_MARKER = "ORIGINAL-INDEMNITY-PROCEDURE";
const SKILL_AUTHORED_MARKER = "AUTHORED-BY-THE-SKILL-UPDATE";
/** The third skill of the partial-authoring journey; the fixture fails it once. */
const SKILL_THIRD = "cure-period-review";
const SKILL_LOADER_TOOL = "mcp__pipeline_skills__load_skill";
const RUNTIME_ANSWER = "termination-review-executed-from-the-authored-skill";
const UPLOAD_FILE_NAME = "startup-bubble-popper.md";
const UPLOAD_RUN_ORDER_MARKER = "RUN-ORDER-POP-THE-LARGEST-BUBBLE-FIRST";
const UPLOAD_ATTACHMENT_LABEL = "Documents first attached for the following user message";
const UPLOAD_ANSWER_PREFIX = "The file you just attached starts its Run Order with ";
const UPLOAD_FALSE_PROVENANCE =
  "No new file arrived with that message. The document was uploaded at the start of the conversation.";
/** What the Architect authors with. Never what a created Agent runs on. */
const AUTHORING_MODEL = {
  id: "fixture/resource-architect",
  name: "Resource Architect Fixture Model",
} as const;
/** The one application default a created Agent inherits. */
const APP_DEFAULT_MODEL = {
  id: "fixture/app-default",
  name: "Fixture App Default Model",
} as const;
/**
 * Whether this request is the Architect or the Agent generator, rather than a
 * created Agent taking its own turn.
 *
 * Recognised by the prompts those two paths own. It has to be positive: the
 * Agent Architect includes whole existing personas as exemplars
 * (`agent-prompt.ts:209-221`), so an authoring request can carry a generated
 * Agent's marker without that Agent having run.
 */
function isAuthoringRequest(system: string): boolean {
  return (
    system.includes("CONVERSATION_RESPONSE_POLICY") ||
    system.includes("RESOURCE_ARCHITECT_RESPONSE_SCHEMA") ||
    system.includes("# Agent Architect")
  );
}

/** A phrase unique to one generated persona, so a run request can be attributed. */
function personaMarker(agentName: string): string {
  return `PERSONA-MARKER-${agentName}`;
}

test("Agent and Team tabs show the same edge-aligned search above populated lists", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("search-user-data");
  const projectRoot = testInfo.outputPath("search-project");
  await fs.mkdir(userDataPath, { recursive: true });
  for (let index = 0; index < 30; index += 1) {
    const name = `sidebar-overflow-agent-${String(index).padStart(2, "0")}`;
    const personaPath = path.join(projectRoot, "agents", name, `${name}.md`);
    await fs.mkdir(path.dirname(personaPath), { recursive: true });
    await fs.writeFile(personaPath, persona(name));
  }
  await seedSidebarTeam(projectRoot);

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({
      projectRoot,
      providerUrl: provider.baseUrl,
      userDataPath,
    });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.getByRole("button", { name: "Use dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();

    const resourceTabs = page.getByRole("tablist", { name: "Resource type" });
    const leftSidebar = page.locator(
      '[data-slot="workspace-sidebar"][data-side="left"]',
    );
    await expect(resourceTabs.getByRole("tab", { name: "Agents" })).toBeVisible();
    await expect(resourceTabs.getByRole("tab", { name: "Teams" })).toBeVisible();
    // 575c37b5 ("Unify agent rows across Create and Run") removed the section
    // headings this journey originally aligned against. The edge-alignment
    // contract now covers the elements that exist: the search trigger row and
    // the first item row must hold identical geometry across both tabs.
    await expect(leftSidebar.getByText("Brief Builder", { exact: true })).toBeVisible();
    const agentSearchRow = await leftSidebar
      .getByRole("button", { name: "Search Agents" })
      .boundingBox();
    const agentItemRow = await leftSidebar
      .getByRole("button", { name: /^Brief Builder/ })
      .boundingBox();
    expect(agentSearchRow).not.toBeNull();
    expect(agentItemRow).not.toBeNull();

    await resourceTabs.getByRole("tab", { name: "Teams" }).click();
    await expect(leftSidebar.getByText("App Brainstorm Team", { exact: true })).toBeVisible();
    const teamSearchRow = await leftSidebar
      .getByRole("button", { name: "Search Teams" })
      .boundingBox();
    const teamItemRow = await leftSidebar
      .getByRole("button", { name: /^App Brainstorm Team/ })
      .boundingBox();
    expect(teamSearchRow).not.toBeNull();
    expect(teamItemRow).not.toBeNull();
    expect(Math.abs(agentSearchRow!.x - teamSearchRow!.x)).toBeLessThan(1);
    expect(Math.abs(agentSearchRow!.width - teamSearchRow!.width)).toBeLessThan(1);
    expect(Math.abs(agentItemRow!.x - teamItemRow!.x)).toBeLessThan(1);

    await resourceTabs.getByRole("tab", { name: "Agents" }).click();
    await page.getByRole("button", { name: "Search Agents" }).click();
    await expect(page.getByRole("searchbox", { name: "Search Agents" })).toBeVisible();
    await expect(leftSidebar.getByText("Brief Builder", { exact: true })).toBeVisible();
    const agentSearch = page
      .getByRole("searchbox", { name: "Search Agents" })
      .locator("xpath=ancestor::form");
    const agentSearchBox = await agentSearch.boundingBox();
    const agentClearBox = await page.getByRole("button", { name: "Clear search" }).boundingBox();
    const sidebarBox = await leftSidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(agentSearchBox).not.toBeNull();
    expect(agentClearBox).not.toBeNull();
    const agentsSearchScreenshot = testInfo.outputPath("agents-search-open.png");
    await leftSidebar.screenshot({ path: agentsSearchScreenshot });
    await testInfo.attach("agents-search-open", {
      path: agentsSearchScreenshot,
      contentType: "image/png",
    });
    expect(horizontalInsetDifference(sidebarBox!, agentSearchBox!)).toBeLessThanOrEqual(1);
    expect(rightInset(agentSearchBox!, agentClearBox!)).toBeCloseTo(4, 0);

    await resourceTabs.getByRole("tab", { name: "Teams" }).click();
    await expect(page.getByRole("searchbox", { name: "Search Teams" })).toBeVisible();
    await expect(leftSidebar.getByText("App Brainstorm Team", { exact: true })).toBeVisible();
    const teamSearch = page
      .getByRole("searchbox", { name: "Search Teams" })
      .locator("xpath=ancestor::form");
    const teamSearchBox = await teamSearch.boundingBox();
    const teamClearBox = await page.getByRole("button", { name: "Clear search" }).boundingBox();
    expect(teamSearchBox).not.toBeNull();
    expect(teamClearBox).not.toBeNull();
    const teamsSearchScreenshot = testInfo.outputPath("teams-search-open.png");
    await leftSidebar.screenshot({ path: teamsSearchScreenshot });
    await testInfo.attach("teams-search-open", {
      path: teamsSearchScreenshot,
      contentType: "image/png",
    });
    expect(horizontalInsetDifference(sidebarBox!, teamSearchBox!)).toBeLessThanOrEqual(1);
    expect(rightInset(teamSearchBox!, teamClearBox!)).toBeCloseTo(4, 0);
    expect(Math.abs(agentSearchBox!.x - teamSearchBox!.x)).toBeLessThan(1);
    expect(Math.abs(agentSearchBox!.width - teamSearchBox!.width)).toBeLessThan(1);
  } finally {
    await closeDesktopResources(app, provider.close);
  }
});

test("Agents and Teams creates a standalone Agent batch without replacing the selected Agent", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("resource-user-data");
  const projectRoot = testInfo.outputPath("resource-project");
  await fs.mkdir(userDataPath, { recursive: true });
  const scopingPath = path.join(
    projectRoot,
    "agents",
    "scoping-lawyer",
    "scoping-lawyer.md",
  );
  const scopingPersona = persona("scoping-lawyer", "ORIGINAL-SCOPING-BOUNDARY");
  await fs.mkdir(path.dirname(scopingPath), { recursive: true });
  await fs.writeFile(scopingPath, scopingPersona);

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({
      projectRoot,
      providerUrl: provider.baseUrl,
      userDataPath,
    });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();

    const leftSidebar = page.locator(
      '[data-slot="workspace-sidebar"][data-side="left"]',
    );
    expect(await leftSidebar.locator("button").allTextContents()).toContain(
      "Scoping Lawyer",
    );
    await leftSidebar.getByText("Scoping Lawyer", { exact: true }).click();
    await expect(page.getByText(/scoping-lawyer\.md$/)).toBeVisible();

    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();
    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await expect(composer).toBeEnabled();
    await composer.fill("Create for me now the other three lawyers.");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const chatSection = page
      .getByText("Agent Architect", { exact: true })
      .locator("xpath=ancestor::section[1]");
    const chatNode = await chatSection.elementHandle();
    expect(chatNode).not.toBeNull();

    await expect(chatSection).toContainText(
      "I have enough information to prepare an Agent proposal.",
    );
    await expect.poll(provider.generationRequests).toBe(0);
    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    for (const name of plannedNames) {
      await expect(page.getByLabel(`Agent ${name}`)).toBeVisible();
    }
    await expect.poll(provider.generationRequests).toBe(0);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(provider.generationRequests).toBe(3);
    for (const name of plannedNames) {
      await expect(page.getByLabel(`Agent ${name}`)).toContainText(/generating|planned/i);
    }

    provider.releaseGeneration();
    for (const name of plannedNames) {
      await expect(page.getByLabel(`Agent ${name}`)).toContainText("created", {
        timeout: 15_000,
      });
    }

    await expect(page.getByText(new RegExp(`${plannedNames[0]}\\.md$`))).toBeVisible();
    await expect(page.locator("textarea:not([placeholder])")).toHaveValue(
      new RegExp(`name: ${plannedNames[0]}`),
    );
    await page.getByRole("button", { name: `Open ${plannedNames[1]}` }).click();
    await expect(page.getByText(new RegExp(`${plannedNames[1]}\\.md$`))).toBeVisible();
    await expect(page.locator("textarea:not([placeholder])")).toHaveValue(
      new RegExp(`name: ${plannedNames[1]}`),
    );
    expect(await chatNode!.evaluate((node) => node.isConnected)).toBe(true);

    expect(await fs.readFile(scopingPath, "utf8")).toBe(scopingPersona);
    for (const name of plannedNames) {
      await expect.poll(async () =>
        fs.readFile(path.join(projectRoot, "agents", name, `${name}.md`), "utf8")
          .then((value) => value.includes(`name: ${name}`))
          .catch(() => false),
      ).toBe(true);
    }
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

/** What the user asks for, so the fixture knows to propose the long-brief Agent. */
const LONG_BRIEF_REQUEST = "one supplier contract auditor with a long build brief";
const LONG_BRIEF_AGENT = "supplier-contract-auditor";
/** Exactly 240 characters, the longest summary a proposal may carry. */
const LONG_BRIEF_SUMMARY =
  "Audits supplier agreements clause by clause before procurement signs, flags the renewal, liability, indemnity, payment and termination terms that need negotiation, and explains each risk in plain language, with replacement wording to offer.";
/** Only the brief's last line carries it, so it is on screen only if the whole brief is. */
const LONG_BRIEF_MARKER = "ONLY-IN-THE-FULL-BUILD-BRIEF";
const LONG_BUILD_BRIEF = longBuildBrief();

test("a long Agent build brief produces a compact proposal card and remains reviewable on demand", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("brief-user-data");
  const projectRoot = testInfo.outputPath("brief-project");
  await fs.mkdir(userDataPath, { recursive: true });
  // The paid model boundary is replaced by the local fixture provider. The
  // desktop renderer, proposal API, plan store and build all run unchanged.
  const provider = await startResourceProvider();
  provider.releaseGeneration();
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });
    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();
    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await composer.fill(`Create ${LONG_BRIEF_REQUEST}.`);
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText("I have enough information to prepare an Agent proposal.", { exact: true })).toBeVisible();
    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const card = page.getByLabel(`Agent ${LONG_BRIEF_AGENT}`, { exact: true });
    await expect(card).toContainText(LONG_BRIEF_SUMMARY);
    await expect(card).not.toContainText(LONG_BRIEF_MARKER);
    const summary = card.locator('[data-slot="card-description"]');
    // The three-line cap holds by itself, so a line count cannot tell a whole
    // summary from a cut one. Scroll height can: a cut summary is taller than
    // the box that shows it.
    const measureSummary = () => summary.evaluate((element) => ({
      lines: Math.round(
        element.getBoundingClientRect().height /
          Number.parseFloat(getComputedStyle(element).lineHeight),
      ),
      cut: element.scrollHeight > element.clientHeight,
    }));
    await page.setViewportSize({ width: 1440, height: 920 });
    const normalWidth = await measureSummary();
    expect(normalWidth.lines, "summary lines at a 1440px window").toBeLessThanOrEqual(3);
    expect(normalWidth.cut, "a 240-character summary is cut at a 1440px window").toBe(false);
    await page.screenshot({ path: testInfo.outputPath("brief-card-1440.png") });
    // At the narrowest window the cap cuts the longest summaries short, and
    // the dialog below is where the rest of it can be read.
    await page.setViewportSize({ width: 1100, height: 920 });
    expect((await measureSummary()).lines, "summary lines at a 1100px window").toBeLessThanOrEqual(3);
    await page.screenshot({ path: testInfo.outputPath("brief-card-1100.png") });

    const viewBrief = card.getByRole("button", {
      name: `View build brief for ${displayName(LONG_BRIEF_AGENT)}`,
      exact: true,
    });
    await viewBrief.click();
    const dialog = page.getByRole("dialog", {
      name: `Build brief for ${displayName(LONG_BRIEF_AGENT)}`,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(LONG_BRIEF_SUMMARY);
    const brief = dialog.locator('[data-slot="scroll-area-viewport"]');
    expect(await brief.evaluate((element) => element.textContent)).toBe(LONG_BUILD_BRIEF);
    expect(
      await brief.evaluate((element) => element.scrollHeight > element.clientHeight),
      "a brief longer than the dialog scrolls inside it",
    ).toBe(true);
    const dialogBox = await dialog.boundingBox();
    if (!dialogBox) throw new Error("The build brief dialog has no layout box");
    expect(dialogBox.y + dialogBox.height, "the dialog fits inside the window").toBeLessThanOrEqual(920);
    await page.screenshot({ path: testInfo.outputPath("brief-dialog.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(viewBrief).toBeFocused();

    const generationPrompt = provider.generationPromptFor(LONG_BRIEF_AGENT);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const prompt = await generationPrompt;
    expect(prompt).toContain(LONG_BUILD_BRIEF);
    expect(prompt).not.toContain(LONG_BRIEF_SUMMARY);
    await expect(card).toContainText("created");
  } finally {
    await closeDesktopResources(app, provider.close);
  }
});

test("a plan saved before card summaries reopens with the first sentence of its brief and the whole brief on request", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("legacy-user-data");
  const projectRoot = testInfo.outputPath("legacy-project");
  // The desktop keeps its workspace under the user data folder when no
  // workspace path is given, which is where the plan and conversation go.
  const workspacePath = path.join(userDataPath, "workspace");
  // Saved the way plans were before proposals carried a card summary.
  await new ResourceArchitectStore(workspacePath).savePlan({
    id: "legacy-long-brief-plan",
    kind: "standalone_agents",
    agents: [{
      name: LONG_BRIEF_AGENT,
      role: "Supplier contract auditor",
      description: LONG_BUILD_BRIEF,
      rationale: "Requested to audit supplier agreements before signature.",
    }],
  });
  const conversationPath = path.join(workspacePath, "resource-architect-conversation", "active.json");
  await fs.mkdir(path.dirname(conversationPath), { recursive: true });
  await fs.writeFile(conversationPath, `${JSON.stringify(resourceArchitectConversationSchema.parse({
    schemaVersion: 1,
    draftId: "legacy-draft",
    history: [
      { role: "user", text: `Create ${LONG_BRIEF_REQUEST}.`, createdAt: "2026-09-19T10:00:00.000Z" },
      { role: "assistant", text: `Proposal ready for review: ${LONG_BRIEF_AGENT}.`, createdAt: "2026-09-19T10:00:05.000Z" },
    ],
    planId: "legacy-long-brief-plan",
    buildJobId: null,
    selectedResource: null,
    documentReader: null,
    updatedAt: "2026-09-19T10:00:05.000Z",
    turn: { jobId: "legacy-proposal", operation: "proposal", status: "completed" },
  }))}\n`);
  // No chat turn is sent. The fixture only satisfies the desktop's provider settings.
  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();

    const card = page.getByLabel(`Agent ${LONG_BRIEF_AGENT}`, { exact: true });
    await expect(card.locator('[data-slot="card-description"]')).toHaveText(
      "Build an Agent that audits supplier agreements before procurement signs them.",
    );
    await expect(card).not.toContainText(LONG_BRIEF_MARKER);

    await card.getByRole("button", {
      name: `View build brief for ${displayName(LONG_BRIEF_AGENT)}`,
      exact: true,
    }).click();
    const dialog = page.getByRole("dialog", {
      name: `Build brief for ${displayName(LONG_BRIEF_AGENT)}`,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    expect(
      await dialog.locator('[data-slot="scroll-area-viewport"]').evaluate((element) => element.textContent),
    ).toBe(LONG_BUILD_BRIEF);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } finally {
    await closeDesktopResources(app, provider.close);
  }
});

/**
 * A build brief of several thousand characters, laid out the way the Architect
 * writes one: a purpose, a run order, and a rule for every clause family.
 */
function longBuildBrief(): string {
  const clauseFamilies = [
    "renewal", "termination", "liability cap", "indemnity", "payment terms",
    "service levels", "data protection", "audit rights", "assignment",
    "governing law", "confidentiality", "insurance",
  ];
  return [
    "Build an Agent that audits supplier agreements before procurement signs them.",
    "",
    "Run order:",
    ...clauseFamilies.map((family, index) =>
      `${index + 1}. Find every ${family} clause, quote it exactly, compare it with the procurement playbook position for ${family}, and record whether it is acceptable, needs negotiation, or must go to legal counsel, with a one-paragraph reason.`),
    "",
    "Output rules:",
    ...clauseFamilies.map((family) =>
      `- For ${family}, state the risk in plain language, name the obligation it places on the buyer, and propose replacement wording the supplier is likely to accept.`),
    "",
    `Final check: ${LONG_BRIEF_MARKER}. Confirm every clause family above has a verdict before the report is returned.`,
  ].join("\n");
}

test("internet access choices survive creation and tool switches save immediately", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("internet-user-data");
  const projectRoot = testInfo.outputPath("internet-project");
  await fs.mkdir(userDataPath, { recursive: true });
  // The paid model boundary is replaced by a local HTTP provider. The desktop,
  // proposal API, build and persona persistence all run unchanged.
  const provider = await startResourceProvider();
  provider.releaseGeneration();
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });
    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    // A build with Workflows enabled, as every desktop E2E build is, opens
    // Create on its Workflows tab.
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();
    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await composer.fill("Create three lawyers with internet access for current sources.");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText("I have enough information to prepare an Agent proposal.", { exact: true })).toBeVisible();
    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const recommended = page.getByRole("switch", { name: "Enable internet access for Michigan Contract Lawyer", exact: true });
    const declined = page.getByRole("switch", { name: "Enable internet access for Commercial Risk Lawyer", exact: true });
    const offline = page.getByRole("switch", { name: "Enable internet access for Drafting Completeness Lawyer", exact: true });
    await expect(recommended).toBeChecked();
    await expect(declined).toBeChecked();
    await expect(offline).not.toBeChecked();
    await declined.click();
    await expect(declined).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("internet-proposal.png") });
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByLabel("Agent michigan-contract-lawyer", { exact: true })).toContainText("created");
    await expect(page.getByLabel("Agent commercial-risk-lawyer", { exact: true })).toContainText("created");
    await expect(page.getByLabel("Agent drafting-completeness-lawyer", { exact: true })).toContainText("created");
    const readPersona = (name: string) => fs.readFile(path.join(projectRoot, "agents", name, `${name}.md`), "utf8");
    expect(await readPersona("michigan-contract-lawyer")).toMatch(/^tools: research_web$/m);
    expect(await readPersona("commercial-risk-lawyer")).toMatch(/^tools: none$/m);
    expect(await readPersona("drafting-completeness-lawyer")).toMatch(/^tools: none$/m);

    await page.getByRole("button", { name: "Open michigan-contract-lawyer", exact: true }).click();
    await page.getByRole("tab", { name: /^Tools/ }).click();
    const research = page.getByRole("switch", { name: "Toggle Web research", exact: true });
    await expect(research).toBeChecked();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    const savedOff = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/create/agents/save"));
    await research.click();
    await savedOff;
    expect(await readPersona("michigan-contract-lawyer")).toMatch(/^tools: none$/m);
    await page.screenshot({ path: testInfo.outputPath("internet-autosaved.png") });
  } finally {
    await closeDesktopResources(app, provider.close);
  }
});

test("stopping a Team build shows the Team and unfinished roster members as cancelled", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("cancel-user-data");
  const projectRoot = testInfo.outputPath("cancel-project");
  await fs.mkdir(userDataPath, { recursive: true });

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({
      projectRoot,
      providerUrl: provider.baseUrl,
      userDataPath,
    });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();
    await page
      .getByPlaceholder("Describe the Agents or Team you need…")
      .fill("Create a contract review team now.");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    await expect(page.getByText(
      "I have enough information to prepare a Team proposal.",
      { exact: true },
    )).toBeVisible();
    await expect.poll(provider.generationRequests).toBe(0);
    await page
      .getByPlaceholder("Describe the Agents or Team you need…")
      .fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const card = page.getByLabel("Team contract-review-team");
    await expect(card).toBeVisible();
    await expect.poll(provider.generationRequests).toBe(0);
    await card.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(provider.generationRequests).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Stop generation" }).click();

    await expect(card).toContainText("cancelled", { timeout: 15_000 });
    await expect(card).not.toContainText(/generating|planned/i);
    for (const name of plannedNames) {
      await expect(
        card.getByRole("listitem", {
          name: `${displayName(name)} cancelled`,
        }),
      ).toBeVisible();
    }
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

test("Agents and Teams updates a created Team when the user types its visible name", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataPath = testInfo.outputPath("created-team-update-user-data");
  const projectRoot = testInfo.outputPath("created-team-update-project");
  await fs.mkdir(userDataPath, { recursive: true });

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();

    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    const proposalReady = page.getByText(
      "I have enough information to prepare a Team proposal.",
      { exact: true },
    );
    await composer.fill("Create a contract review team now.");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(proposalReady).toHaveCount(1);

    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const creationCard = page.getByLabel(`Team ${UPDATE_TEAM_ID}`);
    await expect(creationCard).toBeVisible();
    await expect.poll(provider.generationRequests).toBe(0);
    await creationCard.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(provider.generationRequests).toBe(plannedNames.length);
    provider.releaseGeneration();
    await expect(creationCard).toContainText("created", { timeout: 30_000 });

    const teamYamlPath = path.join(projectRoot, "teams", UPDATE_TEAM_ID, "team.yaml");
    const newAgentPath = path.join(
      projectRoot,
      "agents",
      CREATED_TEAM_NEW_AGENT,
      `${CREATED_TEAM_NEW_AGENT}.md`,
    );
    await expect.poll(
      async () => fs.readFile(teamYamlPath, "utf8")
        .then((yaml) =>
          [...yaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1])
        )
        .catch(() => []),
      { timeout: 30_000 },
    ).toEqual(plannedNames);
    const createdTeamYaml = await fs.readFile(teamYamlPath, "utf8");
    const ownershipMarker = createdTeamYaml.match(/^  created_by_orchestrator: .+$/mu)?.[0];
    if (!ownershipMarker) throw new Error("created Team has no orchestration ownership marker");
    expect(existsSync(newAgentPath)).toBe(false);
    await creationCard.getByRole("button", { name: `Open ${UPDATE_TEAM_ID}` }).click();

    await composer.fill(
      `I would like to add a new ${CREATED_TEAM_NEW_AGENT} Agent to the ${displayName(UPDATE_TEAM_ID).toLowerCase()}.`,
    );
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(proposalReady).toHaveCount(2);

    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const updateCard = page.getByLabel(`Update team ${UPDATE_TEAM_ID}`);
    await expect(updateCard).toBeVisible();
    await expect(updateCard).toContainText(displayName(CREATED_TEAM_NEW_AGENT));
    await expect.poll(provider.generationRequests).toBe(plannedNames.length);
    expect(existsSync(newAgentPath)).toBe(false);

    await updateCard.getByRole("button", { name: "Apply update", exact: true }).click();
    await expect.poll(provider.generationRequests).toBe(plannedNames.length + 1);
    await expect(updateCard).toContainText("updated", { timeout: 30_000 });

    const updatedTeamYaml = await fs.readFile(teamYamlPath, "utf8");
    expect(
      [...updatedTeamYaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1]),
    ).toEqual([...plannedNames, CREATED_TEAM_NEW_AGENT]);
    expect(updatedTeamYaml).toContain(ownershipMarker);
    expect(await fs.readFile(newAgentPath, "utf8")).toContain(
      `name: ${CREATED_TEAM_NEW_AGENT}`,
    );
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

test("a Team created and reopened through the desktop carries no model grade", async ({}, testInfo) => {
  // Phase 7's visible behaviour, end to end through the real renderer and API.
  //
  // The fixture deliberately volunteers what authoring no longer has: every
  // proposed Agent carries `tier`, and every generated persona carries `tier`,
  // `provider` and `model`. None of it may reach a file. An API-level check
  // cannot close this — what a person creates here is what they open again,
  // and a roster the renderer could not read would still pass a server test.
  test.setTimeout(150_000);
  const userDataPath = testInfo.outputPath("no-grade-user-data");
  const projectRoot = testInfo.outputPath("no-grade-project");
  await fs.mkdir(userDataPath, { recursive: true });

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();

    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    const proposalReady = page.getByText(
      "I have enough information to prepare a Team proposal.",
      { exact: true },
    );
    await composer.fill("Create a contract review team now.");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(proposalReady).toHaveCount(1);

    // The card is drawn from the proposal request that the Architect's reply
    // asks for, so the test waits for that request's own response before it
    // looks for the card. A fixed wait for the card alone ran out once while
    // the proposal was still being generated.
    const proposalAnswered = page.waitForResponse(
      (response) => {
        if (response.request().method() !== "POST") return false;
        if (!new URL(response.url()).pathname.endsWith("/create/resource-architect/turn")) return false;
        const body: unknown = response.request().postDataJSON();
        return typeof body === "object" && body !== null && "operation" in body && body.operation === "proposal";
      },
      { timeout: 30_000 },
    );
    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    expect((await proposalAnswered).ok()).toBe(true);

    const creationCard = page.getByLabel(`Team ${UPDATE_TEAM_ID}`);
    await expect(creationCard).toBeVisible();
    await creationCard.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(provider.generationRequests).toBe(plannedNames.length);
    provider.releaseGeneration();
    await expect(creationCard).toContainText("created", { timeout: 30_000 });
    // The Team itself published, not only its Agents created: the card offers
    // to open it only once the build has written the published team.yaml, so
    // the snapshot below is of the file as the build left it.
    await expect(
      creationCard.getByRole("button", { name: `Open ${UPDATE_TEAM_ID}` }),
    ).toBeVisible({ timeout: 30_000 });

    const teamYamlPath = path.join(projectRoot, "teams", UPDATE_TEAM_ID, "team.yaml");
    // The Open wait above guarantees this is the final, published file.
    const createdTeamYaml = await fs.readFile(teamYamlPath, "utf8");
    expect(
      [...createdTeamYaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1]),
    ).toEqual(plannedNames);

    // The roster the build wrote. Every member is there, and none has a grade.
    expect(createdTeamYaml).not.toMatch(/^\s*tier:/mu);
    for (const name of plannedNames) {
      expect(createdTeamYaml).toContain(`- name: "${name}"`);
    }

    // And every persona the architect wrote. The fixture supplied a grade and
    // a runtime pair in each one; the file has neither, and is otherwise the
    // Agent that was asked for.
    for (const name of plannedNames) {
      const personaPath = path.join(projectRoot, "agents", name, `${name}.md`);
      const persona = await fs.readFile(personaPath, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(persona)?.[1] ?? "";
      expect(frontmatter).not.toMatch(/^tier:/mu);
      expect(frontmatter).not.toMatch(/^provider:/mu);
      expect(frontmatter).not.toMatch(/^model:/mu);
      expect(frontmatter).toMatch(new RegExp(`^name: ${name}$`, "mu"));
      expect(frontmatter).toMatch(/^description: /mu);
    }

    // Reopened: the Team the person just made is readable again, and the
    // roster renders from a file with no grades in it.
    await creationCard.getByRole("button", { name: `Open ${UPDATE_TEAM_ID}` }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    await page
      .getByRole("button", { name: new RegExp(`^${displayName(UPDATE_TEAM_ID)}\\b`) })
      .first()
      .click();
    // Scoped to the Team inspector's own roster panel. The finished creation
    // card is still on screen and renders its own list items for the same
    // Agents, so an unscoped match would read that card instead and say
    // nothing about what reopening the Team shows.
    const rosterPanel = page
      .locator('[data-slot="team-roster-editor"]')
      .filter({ has: page.locator('[data-slot="panel-title"]', { hasText: "Agent Roster" }) });
    await expect(rosterPanel, "the Team inspector's roster panel").toHaveCount(1);
    for (const name of plannedNames) {
      // Each member by the action that names it, so the assertion is tied to
      // that member's own row rather than to text anywhere in the panel.
      const removeLabel = `Remove ${displayName(name)} from team roster`;
      await expect(
        rosterPanel.getByRole("button", { name: removeLabel, exact: true }),
      ).toHaveCount(1);
      // `has:` matches its inner locator relative to each candidate, so it has
      // to be page-rooted; a locator already scoped to the panel resolves
      // against the wrong root and matches nothing.
      const entry = rosterPanel.getByRole("listitem").filter({
        has: page.getByRole("button", { name: removeLabel, exact: true }),
      });
      await expect(entry).toHaveCount(1);
      // A grade the member no longer declares, interpolated into a label, is
      // the failure this catches.
      await expect(entry).not.toContainText("undefined");
    }

    // Nothing about reopening rewrote the file.
    expect(await fs.readFile(teamYamlPath, "utf8")).toBe(createdTeamYaml);
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

test("a Team the Architect created runs on the application default, not on the authoring model", async ({}, testInfo) => {
  // The last leg of the master plan's Capability D journey: create, save,
  // reopen, and *run*. File inspection alone cannot close it — a persona with
  // no pair still has to result in the app default actually being dispatched.
  //
  // The two models are deliberately different. The Architect authors with one
  // and the application default is the other, so "ran on the app default" can
  // be told apart from "ran on whatever wrote the file". Each member is
  // attributed by a marker unique to its own generated persona rather than by
  // arrival order.
  test.setTimeout(240_000);
  const userDataPath = testInfo.outputPath("created-run-user-data");
  const projectRoot = testInfo.outputPath("created-run-project");
  await fs.mkdir(userDataPath, { recursive: true });

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl, APP_DEFAULT_MODEL.name);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText(AUTHORING_MODEL.name, { exact: true }).click();

    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await composer.fill("Create a contract review team now.");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(
      page.getByText("I have enough information to prepare a Team proposal.", {
        exact: true,
      }),
    ).toHaveCount(1);

    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const creationCard = page.getByLabel(`Team ${UPDATE_TEAM_ID}`);
    await expect(creationCard).toBeVisible();
    await creationCard.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(provider.generationRequests).toBe(plannedNames.length);
    provider.releaseGeneration();
    await expect(creationCard).toContainText("created", { timeout: 30_000 });
    // "created" above can come from a member's row while the Team itself is
    // still generating. The build is finished only when the Team's own label
    // reads "created" too: one label per member plus the Team's, and nothing
    // left generating. Leaving Create earlier lets the build's completion bring
    // the app back to Create after the Run tab was chosen.
    await expect(creationCard.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(creationCard.getByText("created", { exact: true })).toHaveCount(plannedNames.length + 1);

    const teamYamlPath = path.join(projectRoot, "teams", UPDATE_TEAM_ID, "team.yaml");
    await expect.poll(
      async () => fs.readFile(teamYamlPath, "utf8")
        .then((yaml) =>
          [...yaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1])
        )
        .catch(() => []),
      { timeout: 30_000 },
    ).toEqual(plannedNames);

    // Nothing has run yet. Creation and generation are authoring requests, and
    // the recorder must have counted none of them as a member's own turn —
    // otherwise the run assertions below could pass on authoring traffic.
    for (const name of plannedNames) {
      expect(provider.modelsDispatchedFor(personaMarker(name))).toEqual([]);
    }

    // ── Run the Team that was just created ────────────────────────────────
    const runTab = page.getByRole("tab", { name: "Run", exact: true });
    await runTab.click();
    await expect(runTab).toHaveAttribute("aria-selected", "true");
    await page
      .getByRole("tablist", { name: "Run target type" })
      .getByRole("tab", { name: "Teams", exact: true })
      .click();
    await page.getByRole("radio", { name: displayName(UPDATE_TEAM_ID) }).click();

    const runComposer = page.getByRole("textbox").first();
    await runComposer.fill("Review the attached supply agreement.");
    await runComposer.press("Enter");

    // What each member actually ran on, from the provider's own record. Polled
    // on the set of distinct ids, so a member dispatched more than once still
    // has to have used one model throughout, and a member dispatched on the
    // authoring model fails rather than waits.
    //
    // Polled concurrently, not in a loop: the members run concurrently too, and
    // a sequential loop would let one member that never dispatches burn the
    // whole test timeout before the others are even looked at — ending in a
    // bare "Test timed out" instead of the member's name.
    await Promise.all(
      plannedNames.map((name) =>
        expect
          .poll(() => provider.modelsDispatchedFor(personaMarker(name)), {
            timeout: 150_000,
            message: `member ${name} was never dispatched on the application default`,
          })
          .toEqual([APP_DEFAULT_MODEL.id]),
      ),
    );

    // Only now the files, so a change that kept the authoring pair fails on the
    // dispatched model above rather than being stopped short of the run.
    for (const name of plannedNames) {
      const persona = await fs.readFile(
        path.join(projectRoot, "agents", name, `${name}.md`),
        "utf8",
      );
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(persona)?.[1] ?? "";
      expect(frontmatter).not.toMatch(/^provider:/mu);
      expect(frontmatter).not.toMatch(/^model:/mu);
      expect(frontmatter).not.toMatch(/^tier:/mu);
    }
    expect(await fs.readFile(teamYamlPath, "utf8")).not.toMatch(/^\s*tier:/mu);
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

test("Agents and Teams updates an existing Team through the real renderer and API", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("update-user-data");
  const projectRoot = testInfo.outputPath("update-project");
  await fs.mkdir(userDataPath, { recursive: true });
  const teamYamlPath = await seedExistingTeamForUpdate(projectRoot);
  const originalTeamYaml = await fs.readFile(teamYamlPath, "utf8");

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({
      projectRoot,
      providerUrl: provider.baseUrl,
      userDataPath,
    });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();

    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await expect(composer).toBeEnabled();
    await composer.fill(
      `Add ${UPDATE_LIBRARY_AGENT} and a new ${UPDATE_NEW_AGENT} to the ${UPDATE_TEAM_ID} team.`,
    );
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText(
      "I have enough information to prepare a Team proposal.",
      { exact: true },
    )).toBeVisible();

    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const card = page.getByLabel(`Update team ${UPDATE_TEAM_ID}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Update Team Contract Review Team");
    await expect(card).toContainText(displayName(UPDATE_LIBRARY_AGENT));
    await expect(card).toContainText(displayName(UPDATE_NEW_AGENT));

    // Reviewing a proposal writes nothing: the Team on disk is byte-identical
    // and no Agent was generated.
    expect(await fs.readFile(teamYamlPath, "utf8")).toBe(originalTeamYaml);
    await expect.poll(provider.generationRequests).toBe(0);

    await card.getByRole("button", { name: "Apply update", exact: true }).click();
    await expect.poll(provider.generationRequests).toBe(1);
    provider.releaseGeneration();

    await expect(card).toContainText("updated", { timeout: 20_000 });

    await expect.poll(
      async () => {
        const yaml = await fs.readFile(teamYamlPath, "utf8");
        return {
          roster: [...yaml.matchAll(/^ {2}- name: "([^"]+)"$/gmu)].map((match) => match[1]),
          participants: participantNames(yaml),
          keepsCustomGate: yaml.includes(UPDATE_CUSTOM_MARKER),
          claimsCreationOwnership: yaml.includes("created_by_orchestrator"),
        };
      },
      { timeout: 20_000 },
    ).toEqual({
      roster: [UPDATE_SEEDED_AGENT, UPDATE_LIBRARY_AGENT, UPDATE_NEW_AGENT],
      participants: [UPDATE_SEEDED_AGENT, UPDATE_LIBRARY_AGENT, UPDATE_NEW_AGENT],
      keepsCustomGate: true,
      claimsCreationOwnership: false,
    });
    expect(
      await fs.readFile(
        path.join(projectRoot, "agents", UPDATE_NEW_AGENT, `${UPDATE_NEW_AGENT}.md`),
        "utf8",
      ),
    ).toContain(`name: ${UPDATE_NEW_AGENT}`);
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

test("Agents and Teams updates an existing Agent's skills through the real renderer and API", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("skill-update-user-data");
  const projectRoot = testInfo.outputPath("skill-update-project");
  await fs.mkdir(userDataPath, { recursive: true });
  await seedExistingAgentForSkillUpdate(projectRoot);
  const existingSkillPath = path.join(
    projectRoot, "agents", SKILL_AGENT, "skills", SKILL_EXISTING, "SKILL.md",
  );
  const newSkillPath = path.join(
    projectRoot, "agents", SKILL_AGENT, "skills", SKILL_NEW, "SKILL.md",
  );
  const personaPath = path.join(projectRoot, "agents", SKILL_AGENT, `${SKILL_AGENT}.md`);
  const originalSkill = await fs.readFile(existingSkillPath, "utf8");
  const originalPersona = await fs.readFile(personaPath, "utf8");

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();

    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await expect(composer).toBeEnabled();
    await composer.fill(
      `Give ${SKILL_AGENT} a new ${SKILL_NEW} skill and rewrite its ${SKILL_EXISTING} skill.`,
    );
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText(
      "I have enough information to prepare an Agent proposal.",
      { exact: true },
    )).toBeVisible();

    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const card = page.getByLabel(`Update agent ${SKILL_AGENT}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Update Agent Michigan Contract Lawyer");
    await expect(card).toContainText(SKILL_NEW);
    await expect(card).toContainText(SKILL_EXISTING);

    // Reviewing a proposal writes nothing: no skill was authored, the skill
    // the update will rewrite is byte-identical, and the new one is absent.
    await expect.poll(provider.skillAuthorRequests).toBe(0);
    expect(await fs.readFile(existingSkillPath, "utf8")).toBe(originalSkill);
    expect(existsSync(newSkillPath)).toBe(false);

    await card.getByRole("button", { name: "Apply update", exact: true }).click();

    // Each skill row now carries its own status, so the whole update is proven
    // by the card's status, not by any "updated" text on the card.
    await expect(
      card.locator('[data-slot="card-action"]').getByText("updated", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(card.getByLabel(`Create skill ${SKILL_NEW} updated`, { exact: true })).toBeVisible();
    await expect(card.getByLabel(`Update skill ${SKILL_EXISTING} updated`, { exact: true })).toBeVisible();
    await expect.poll(provider.skillAuthorRequests, { timeout: 30_000 }).toBe(2);

    // The Agent's own files: the two named skills rewritten and created, the
    // persona untouched.
    expect(await fs.readFile(newSkillPath, "utf8")).toContain(SKILL_AUTHORED_MARKER);
    const rewritten = await fs.readFile(existingSkillPath, "utf8");
    expect(rewritten).toContain(SKILL_AUTHORED_MARKER);
    expect(rewritten).not.toContain(SKILL_ORIGINAL_MARKER);
    expect(await fs.readFile(personaPath, "utf8")).toBe(originalPersona);

    // The finished update selects the Agent it changed, not a Team.
    await expect(page.getByText(new RegExp(`${SKILL_AGENT}\\.md$`))).toBeVisible({
      timeout: 20_000,
    });

    // A real reload: the inspector reads the Agent package from disk again, so
    // a skill that did not exist when the window opened is discovered now.
    await page.reload();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    const leftSidebar = page.locator('[data-slot="workspace-sidebar"][data-side="left"]');
    await leftSidebar.getByText(displayName(SKILL_AGENT), { exact: true }).click();
    await page.getByRole("tab", { name: /^Skills/ }).click();

    const skills = page.getByRole("tabpanel").filter({ hasText: SKILL_NEW });
    await expect(skills).toContainText(SKILL_NEW, { timeout: 20_000 });
    await expect(skills).toContainText(SKILL_EXISTING);

    // Discovery is not execution. The Agent is run for real: the catalog the
    // loader built from the package on disk carries the new skill's source and
    // hash, the model loads it through the skill loader, and the answer is
    // returned only once the loaded bytes — which exist nowhere but the file
    // this update wrote — have come back through the tool.
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    const showInspector = page.getByRole("button", { name: "Show inspector" });
    if (await showInspector.isVisible()) await showInspector.click();
    const runAgent = page.getByRole("button", { name: new RegExp(`^${displayName(SKILL_AGENT)}`) });
    if ((await runAgent.getAttribute("aria-pressed")) !== "true") {
      await page.getByRole("button", { name: "Search Agents" }).click();
      await page.getByRole("searchbox", { name: "Search Agents" }).fill(SKILL_AGENT);
      await runAgent.click();
    }
    // The run chat carries its own model choice, and the default one is not
    // the deterministic fixture this journey observes.
    await page.getByRole("button", { name: "Run chat model" }).click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();

    const runInput = page.getByPlaceholder("Send a message to the selected agents...");
    await expect(runInput).toBeEnabled();
    await runInput.fill(
      `Review this draft's termination clause. Use your ${SKILL_NEW} skill.`,
    );
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByText(RUNTIME_ANSWER, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(provider.catalogGap()).toBeNull();
    expect(provider.loadedSkillMarkerObserved()).toBe(true);
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

test("a newly uploaded Markdown file is recognized as part of the next Agent Architect message", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("upload-user-data");
  const projectRoot = testInfo.outputPath("upload-project");
  await fs.mkdir(userDataPath, { recursive: true });
  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();

    // One completed exchange first, so the file arrives in the middle of a
    // conversation rather than before it.
    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await expect(composer).toBeEnabled();
    await composer.fill("I need an Agent that pops startup bubbles.");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText(
      "I have enough information to prepare an Agent proposal.",
      { exact: true },
    )).toBeVisible();

    await page.getByLabel("Upload files").setInputFiles([{
      name: UPLOAD_FILE_NAME,
      mimeType: "text/markdown",
      buffer: Buffer.from(
        `# Startup bubble popper\n\n## Run Order\n\n1. ${UPLOAD_RUN_ORDER_MARKER}\n2. Report the popped bubbles.\n`,
      ),
    }]);
    const fileCard = page.getByTestId("file-message-card").filter({ hasText: UPLOAD_FILE_NAME });
    await expect(fileCard).toContainText("parsed", { timeout: 30_000 });

    await composer.fill("here it is");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    // The fixture answers with the marker only when the document block sits
    // directly before this message and says it was attached to it.
    await expect(page.getByText(
      `${UPLOAD_ANSWER_PREFIX}${UPLOAD_RUN_ORDER_MARKER}.`,
      { exact: true },
    )).toBeVisible();
    await expect(page.getByText(UPLOAD_FALSE_PROVENANCE, { exact: true })).toHaveCount(0);
  } finally {
    await closeDesktopResources(app, provider.close);
  }
});

/**
 * How the fixture Architect answers once an uploaded file is in its request.
 *
 * It names the file's Run Order only when the document block is the message
 * right before the latest user message (with the safety acknowledgment between
 * them), is labelled as attached to that message, and is the only place the
 * file appears. Any other layout gets the false provenance claim the packaged
 * app made, so a regression shows up on screen.
 */
function uploadedFileAnswer(messages: Array<{ role?: string; content?: string }>): string {
  const conversation = messages.filter((message) => message.role !== "system");
  const [block, acknowledgment, latest] = conversation.slice(-3);
  const attachedToLatest =
    block?.role === "user" &&
    block.content?.includes(UPLOAD_ATTACHMENT_LABEL) === true &&
    block.content.includes(UPLOAD_RUN_ORDER_MARKER) &&
    acknowledgment?.role === "assistant" &&
    latest?.role === "user" &&
    latest.content === "here it is" &&
    conversation.filter((message) => message.content?.includes(UPLOAD_RUN_ORDER_MARKER)).length === 1;
  return attachedToLatest
    ? `${UPLOAD_ANSWER_PREFIX}${UPLOAD_RUN_ORDER_MARKER}.`
    : UPLOAD_FALSE_PROVENANCE;
}

/** The Agent a person has open in the Create inspector while asking about it. */
const CONTEXT_AGENT = "run-order-analyst";
/** The persona's own run order, which exists nowhere but the saved persona. */
const CONTEXT_RUN_ORDER = [
  "RUN-ORDER-STEP-ALPHA-7F3",
  "RUN-ORDER-STEP-BRAVO-9K2",
  "RUN-ORDER-STEP-CHARLIE-4M8",
] as const;
/** One marker per saved package file the Tools, Skills and Context tabs show. */
const CONTEXT_FILE_MARKERS = {
  skill: "SKILL-BODY-MARKER-INTAKE-TRIAGE-51Q",
  template: "TEMPLATE-MARKER-LEDGER-BRIEF-22D",
  reference: "REFERENCE-MARKER-LEDGER-STANDARDS-83W",
  script: "SCRIPT-MARKER-COLLECT-LEDGER-60Z",
  context: "CONTEXT-MARKER-LEDGER-NOTES-17P",
} as const;
const CONTEXT_BROWSER_DOMAIN = "ledger.example.org";
const CONTEXT_MCP_NAME = "Order Ledger MCP";
/** Connection configuration that must never reach a model. */
const CONTEXT_MCP_URL = "http://127.0.0.1:9/ledger-connection-secret";
const CONTEXT_PACKAGE_UNAVAILABLE =
  "I can see only the library summary for this Agent; its saved package is unavailable to me.";

function contextAnswer(): string {
  return `Saved run order: ${CONTEXT_RUN_ORDER.join(" -> ")}. ` +
    `Tools: research_web and generate_word, websites limited to ${CONTEXT_BROWSER_DOMAIN}, ` +
    `${CONTEXT_MCP_NAME} granted.`;
}

test("asking about the Agent open in Create uses its saved package, tools, and skills", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("selected-package-user-data");
  const projectRoot = testInfo.outputPath("selected-package-project");
  await fs.mkdir(userDataPath, { recursive: true });
  await seedContextAgentPackage(projectRoot);
  await seedContextAgentMcpGrant(userDataPath);

  const provider = await startResourceProvider();
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();
    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await expect(composer).toBeEnabled();
    await composer.fill("What is this Agent's exact run order and tool configuration?");
    // Typing clears the previous selection. Choose the Agent after composing
    // when the question should use that Agent's complete saved package.
    const leftSidebar = page.locator('[data-slot="workspace-sidebar"][data-side="left"]');
    await leftSidebar.getByText(displayName(CONTEXT_AGENT), { exact: true }).click();
    await expect(page.getByText(new RegExp(`${CONTEXT_AGENT}\\.md$`))).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    // The fixture answers from the request it received, and only when every
    // saved file, tool setting and grant reached it inside the package block.
    await expect(page.getByText(contextAnswer(), { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(CONTEXT_PACKAGE_UNAVAILABLE)).toHaveCount(0);
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

/**
 * The answer the fixture gives an Agent Architect conversation about the open
 * Agent, read from the request itself rather than from anything this spec knows.
 */
function answerFromSelectedPackage(system: string): string {
  const opening = `<selected_agent_package agent="${CONTEXT_AGENT}">`;
  const start = system.indexOf(opening);
  const end = system.indexOf("</selected_agent_package>", start);
  if (start === -1 || end === -1) return CONTEXT_PACKAGE_UNAVAILABLE;
  const block = system.slice(start, end);
  const required = [
    ...CONTEXT_RUN_ORDER,
    ...Object.values(CONTEXT_FILE_MARKERS),
    CONTEXT_BROWSER_DOMAIN,
    "generate_word",
    "research_web",
  ];
  const grantRow = new RegExp(`${CONTEXT_MCP_NAME}[^\\n]*granted: yes`);
  if (
    required.some((marker) => !block.includes(marker)) ||
    !grantRow.test(block) ||
    system.includes(CONTEXT_MCP_URL)
  ) {
    return CONTEXT_PACKAGE_UNAVAILABLE;
  }
  const order = [...new Set(block.match(/RUN-ORDER-STEP-[A-Z]+-[0-9A-Z]{3}/g) ?? [])];
  return order.join(",") === CONTEXT_RUN_ORDER.join(",")
    ? contextAnswer()
    : CONTEXT_PACKAGE_UNAVAILABLE;
}

async function seedContextAgentPackage(projectRoot: string): Promise<void> {
  const agentRoot = path.join(projectRoot, "agents", CONTEXT_AGENT);
  const files: Record<string, string> = {
    [`${CONTEXT_AGENT}.md`]: [
      "---",
      `name: ${CONTEXT_AGENT}`,
      "description: Sequences intake work for the operations desk.",
      "tier: specialist",
      "provider: openai",
      "model: fixture/resource-architect",
      "thinking: medium",
      "tools: research_web, generate_word",
      "browser_restrict_domains: true",
      `browser_domains: ${CONTEXT_BROWSER_DOMAIN}`,
      "---",
      "",
      `# ${CONTEXT_AGENT}`,
      "",
      "## Run order",
      "",
      `1. ${CONTEXT_RUN_ORDER[0]}: confirm who owns the request.`,
      `2. ${CONTEXT_RUN_ORDER[1]}: triage it with the intake-triage skill.`,
      `3. ${CONTEXT_RUN_ORDER[2]}: publish the ledger brief.`,
      "",
    ].join("\n"),
    "skills/intake-triage/SKILL.md": [
      "---",
      "name: intake-triage",
      "description: >",
      "  Sort an incoming ledger request by urgency. Use when a new request",
      "  reaches the operations desk.",
      "---",
      "",
      "# intake-triage",
      "",
      `Procedure: ${CONTEXT_FILE_MARKERS.skill}.`,
      "",
    ].join("\n"),
    "skills/intake-triage/templates/ledger-brief.md": `# Brief\n\n${CONTEXT_FILE_MARKERS.template}\n`,
    "skills/intake-triage/references/ledger-standards.md": `# Standards\n\n${CONTEXT_FILE_MARKERS.reference}\n`,
    "scripts/collect-ledger.py": `print("${CONTEXT_FILE_MARKERS.script}")\n`,
    "knowledge/ledger-notes.md": `# Notes\n\n${CONTEXT_FILE_MARKERS.context}\n`,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(agentRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
}

/** One globally enabled MCP connection, granted to the open Agent. */
async function seedContextAgentMcpGrant(userDataPath: string): Promise<void> {
  await fs.writeFile(
    path.join(userDataPath, "mcp-settings.json"),
    `${JSON.stringify({
      version: 1,
      servers: [{
        id: "order-ledger",
        name: CONTEXT_MCP_NAME,
        enabled: true,
        capabilityAliases: [],
        transport: {
          type: "streamable-http",
          url: CONTEXT_MCP_URL,
          encryptedHeaders: {},
          authentication: { type: "none" },
        },
        // Not `connected`, so startup never dials this address.
        status: "disconnected",
        capabilities: { logging: false },
      }],
      agentGrants: [{
        agentPath: `agents/${CONTEXT_AGENT}`,
        serverId: "order-ledger",
        enabled: true,
      }],
    }, null, 2)}\n`,
  );
}

test("a partially authored Agent update reports each skill and resumes without redoing completed work", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("partial-skill-update-user-data");
  const projectRoot = testInfo.outputPath("partial-skill-update-project");
  await fs.mkdir(userDataPath, { recursive: true });
  await seedExistingAgentForSkillUpdate(projectRoot);
  const skillsRoot = path.join(projectRoot, "agents", SKILL_AGENT, "skills");
  const existingSkillPath = path.join(skillsRoot, SKILL_EXISTING, "SKILL.md");
  const newSkillPath = path.join(skillsRoot, SKILL_NEW, "SKILL.md");
  const thirdSkillPath = path.join(skillsRoot, SKILL_THIRD, "SKILL.md");
  const originalSkill = await fs.readFile(existingSkillPath, "utf8");

  // Authors the first two skills and refuses the third once, the way a stalled
  // provider call ends a real batch.
  const provider = await startResourceProvider({ failSkillAuthorOnce: SKILL_THIRD });
  let app: ElectronApplication | undefined;

  try {
    app = await launchDesktop({ projectRoot, providerUrl: provider.baseUrl, userDataPath });
    const page = await app.firstWindow({ timeout: desktopWindowTimeoutMs });

    await configureProvider(page, provider.baseUrl);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByLabel("Agent Architect model").click();
    await page.getByText("Resource Architect Fixture Model", { exact: true }).click();

    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await expect(composer).toBeEnabled();
    await composer.fill(
      `Give ${SKILL_AGENT} a new ${SKILL_NEW} skill, rewrite its ${SKILL_EXISTING} skill, and add a ${SKILL_THIRD} skill.`,
    );
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText(
      "I have enough information to prepare an Agent proposal.",
      { exact: true },
    )).toBeVisible();
    await composer.fill("build it");
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const card = page.getByLabel(`Update agent ${SKILL_AGENT}`);
    const cardStatus = card.locator('[data-slot="card-action"]');
    const row = (action: "Create" | "Update", name: string, status: string) =>
      card.getByLabel(`${action} skill ${name} ${status}`, { exact: true });

    // Before anything runs, every row names its action and says it is planned.
    await expect(row("Create", SKILL_NEW, "planned")).toBeVisible();
    await expect(row("Update", SKILL_EXISTING, "planned")).toBeVisible();
    await expect(row("Create", SKILL_THIRD, "planned")).toBeVisible();

    await card.getByRole("button", { name: "Apply update", exact: true }).click();

    // The third author call fails. The two skills authored before it are
    // staged, the one that failed says so, and the card keeps the reason.
    await expect(cardStatus.getByText("failed", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row("Create", SKILL_NEW, "staged")).toBeVisible();
    await expect(row("Update", SKILL_EXISTING, "staged")).toBeVisible();
    await expect(row("Create", SKILL_THIRD, "failed")).toBeVisible();
    // The failed row gives its own reason, and the card keeps the Agent-level
    // error apart from it: the row's alert alone must not satisfy the second.
    await expect(row("Create", SKILL_THIRD, "failed").getByRole("alert")).toContainText(
      "The skill author did not answer",
    );
    await expect(
      card.getByRole("alert").filter({ hasNotText: "Could not author skill" }),
    ).toContainText("The skill author did not answer");
    expect(provider.skillAuthorNames()).toEqual([SKILL_NEW, SKILL_EXISTING, SKILL_THIRD]);

    // Staged is not updated: nothing reached the live Agent.
    expect(await fs.readFile(existingSkillPath, "utf8")).toBe(originalSkill);
    expect(existsSync(newSkillPath)).toBe(false);
    expect(existsSync(thirdSkillPath)).toBe(false);

    // Retry from the same screen authors only the skill that failed.
    await card.getByRole("button", { name: "Retry", exact: true }).click();

    await expect(cardStatus.getByText("updated", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row("Create", SKILL_NEW, "updated")).toBeVisible();
    await expect(row("Update", SKILL_EXISTING, "updated")).toBeVisible();
    await expect(row("Create", SKILL_THIRD, "updated")).toBeVisible();
    expect(provider.skillAuthorNames()).toEqual([
      SKILL_NEW,
      SKILL_EXISTING,
      SKILL_THIRD,
      SKILL_THIRD,
    ]);

    // The live files hold the exact bytes each author call produced: the first
    // two from the first attempt, the third from the retry.
    expect(await fs.readFile(newSkillPath, "utf8")).toBe(authoredSkillDocument(SKILL_NEW, 1));
    expect(await fs.readFile(existingSkillPath, "utf8")).toBe(
      authoredSkillDocument(SKILL_EXISTING, 2),
    );
    expect(await fs.readFile(thirdSkillPath, "utf8")).toBe(authoredSkillDocument(SKILL_THIRD, 4));
  } finally {
    provider.releaseGeneration();
    await closeDesktopResources(app, provider.close);
  }
});

/** An Agent the Create flow did not build, carrying one conforming skill. */
async function seedExistingAgentForSkillUpdate(projectRoot: string): Promise<void> {
  const personaPath = path.join(projectRoot, "agents", SKILL_AGENT, `${SKILL_AGENT}.md`);
  await fs.mkdir(path.dirname(personaPath), { recursive: true });
  await fs.writeFile(personaPath, skillAgentPersona());
  const skillPath = path.join(
    projectRoot, "agents", SKILL_AGENT, "skills", SKILL_EXISTING, "SKILL.md",
  );
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, existingSkillDocument());
}

/**
 * A persona the runtime can actually run.
 *
 * `{{SKILLS_BLOCK}}` is what the loader replaces with the catalog it builds
 * from the package on disk, so a persona without it would hide the very
 * discovery this journey is about.
 */
function skillAgentPersona(): string {
  return [
    "---",
    `name: ${SKILL_AGENT}`,
    `description: ${SKILL_AGENT} description.`,
    "tier: specialist",
    "provider: openai",
    "model: fixture/resource-architect",
    "thinking: medium",
    "---",
    "",
    `# ${SKILL_AGENT}`,
    "",
    "Review contracts. Load a skill before applying it.",
    "",
    "## Skills",
    "",
    "{{SKILLS_BLOCK}}",
    "",
  ].join("\n");
}

function existingSkillDocument(): string {
  return [
    "---",
    `name: ${SKILL_EXISTING}`,
    "description: >",
    "  Review indemnity clauses for uncapped exposure. Use when a contract",
    "  draft reaches the indemnity review step.",
    "---",
    "",
    `# ${SKILL_EXISTING}`,
    "",
    `Marker: ${SKILL_ORIGINAL_MARKER}.`,
    "",
  ].join("\n");
}

/**
 * The document one skill-author request returns.
 *
 * It names the request that produced it, so a published file shows which
 * author call its bytes came from.
 */
function authoredSkillDocument(name: string, request: number): string {
  return [
    "---",
    `name: ${name}`,
    "description: >",
    `  Walk a contract draft through the ${name} procedure clause by clause.`,
    `  Use when a draft reaches ${name} and the reviewer needs the checklist.`,
    "---",
    "",
    `# ${name}`,
    "",
    `Marker: ${SKILL_AUTHORED_MARKER}.`,
    "",
    `Authored by skill-author request ${request}.`,
    "",
  ].join("\n");
}

/** Entries of the first explicit `participants:` block, and nothing after it. */
function participantNames(yaml: string): string[] {
  const lines = yaml.split("\n");
  const keyIndex = lines.findIndex((line) => /^\s*participants:\s*$/.test(line));
  if (keyIndex < 0) return [];
  const keyIndent = lines[keyIndex]!.match(/^\s*/)![0].length;
  const names: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const entry = lines[index]!.match(/^(\s*)- (.*)$/);
    if (!entry || entry[1]!.length <= keyIndent) break;
    names.push(entry[2]!.trim().replace(/"/g, ""));
  }
  return names;
}

/**
 * A Team the Create flow did not build: no `created_by_orchestrator` marker, an
 * explicit discussion entry stage, and a custom gate no update may rewrite.
 */
async function seedExistingTeamForUpdate(projectRoot: string): Promise<string> {
  for (const name of [UPDATE_SEEDED_AGENT, UPDATE_LIBRARY_AGENT]) {
    const personaPath = path.join(projectRoot, "agents", name, `${name}.md`);
    await fs.mkdir(path.dirname(personaPath), { recursive: true });
    await fs.writeFile(personaPath, persona(name));
  }
  const teamDirectory = path.join(projectRoot, "teams", UPDATE_TEAM_ID);
  await fs.mkdir(teamDirectory, { recursive: true });
  const teamYamlPath = path.join(teamDirectory, "team.yaml");
  await fs.writeFile(
    teamYamlPath,
    [
      "team:",
      `  name: "${UPDATE_TEAM_ID}"`,
      "  description: >",
      "    Reviews contracts from complementary legal perspectives.",
      '  version: "0.1.0"',
      "workflow:",
      "  entry_level: review",
      "  invocation_modes:",
      "    - user",
      "  user_facing: true",
      "agents:",
      `  - name: "${UPDATE_SEEDED_AGENT}"`,
      "    type: agent",
      "    role: >",
      "      Michigan contract reviewer",
      "    tier: strategic",
      "    tools: []",
      `    agent_file: "../../agents/${UPDATE_SEEDED_AGENT}/${UPDATE_SEEDED_AGENT}.md"`,
      "    experience_enabled: true",
      "levels:",
      "  - id: review",
      "    name: Review",
      "    order: 0",
      "    stage:",
      "      type: discussion",
      `      coordinator: "${UPDATE_SEEDED_AGENT}"`,
      "      participants:",
      `        - "${UPDATE_SEEDED_AGENT}"`,
      "      config:",
      "        mode: brainstorm",
      "gates:",
      "  - from: review",
      "    to: done",
      "    condition:",
      "      type: artifact_exists",
      `      artifact: "${UPDATE_CUSTOM_MARKER}.md"`,
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(projectRoot, "teams.yaml"),
    [
      `${UPDATE_TEAM_ID}:`,
      "  type: team",
      "  description: Reviews contracts.",
      `  team_path: ./teams/${UPDATE_TEAM_ID}`,
      "  tags: []",
      "",
    ].join("\n"),
  );
  return teamYamlPath;
}

async function closeDesktopResources(
  app: ElectronApplication | undefined,
  closeProvider: () => Promise<void>,
): Promise<void> {
  const closeOperations: Array<Promise<void>> = [closeProvider()];
  if (app) closeOperations.push(app.close());
  await Promise.allSettled(closeOperations);
}

function horizontalInsetDifference(
  container: { x: number; width: number },
  child: { x: number; width: number },
): number {
  const left = child.x - container.x;
  const right = container.x + container.width - child.x - child.width;
  return Math.abs(left - right);
}

function rightInset(
  container: { x: number; width: number },
  child: { x: number; width: number },
): number {
  return container.x + container.width - child.x - child.width;
}

function displayName(value: string): string {
  return value
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function seedSidebarTeam(projectRoot: string): Promise<void> {
  const teamDirectory = path.join(projectRoot, "teams", "app-brainstorm-team");
  await fs.mkdir(teamDirectory, { recursive: true });
  await fs.writeFile(
    path.join(teamDirectory, "team.yaml"),
    [
      "team:",
      "  name: app-brainstorm-team",
      "  description: Sidebar fixture team.",
      "agents: []",
      "levels: []",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(projectRoot, "teams.yaml"),
    [
      "app-brainstorm-team:",
      "  type: team",
      "  description: Sidebar fixture team.",
      "  team_path: ./teams/app-brainstorm-team",
      "",
    ].join("\n"),
  );
}

async function launchDesktop(params: {
  projectRoot: string;
  providerUrl: string;
  userDataPath: string;
}): Promise<ElectronApplication> {
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
      OPENAI_API_KEY: "resource-electron-key",
      // The Agent runtime resolves its provider from the environment, while
      // the Architect and the skill author use the generator URL below. Both
      // point at the one deterministic fixture this spec runs.
      OPENAI_BASE_URL: params.providerUrl,
      PIPELINE_DESKTOP_E2E: "1",
      // This legacy provider supplies single-pass authoring responses.
      PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "false",
      PIPELINE_DESKTOP_PROJECT_ROOT: params.projectRoot,
      PIPELINE_DESKTOP_USER_DATA: params.userDataPath,
      WORKFLOW_GENERATOR_OPENAI_API_URL: `${params.providerUrl}/chat/completions`,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  });
}

async function configureProvider(
  page: Page,
  providerBaseUrl: string,
  setDefaultTo?: string,
): Promise<void> {
  await page.getByLabel("Settings").click();
  await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByLabel("Connection type").selectOption("openai-compatible");
  await page.getByLabel("Name").fill("Resource Architect Fixture");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByRole("textbox", { name: "API key", exact: true }).fill("fixture-key");
  const concurrency = page.getByRole("spinbutton");
  await concurrency.fill("3");
  await page.getByRole("button", { name: "Save & Validate" }).click();
  await page.getByRole("button", { name: /^Resource Architect Fixture/ }).click();
  for (const model of [AUTHORING_MODEL, APP_DEFAULT_MODEL]) {
    await page.getByRole("switch", { name: `Enable ${model.name}`, exact: true }).click();
  }
  // Named before Settings is closed, through the control a person uses.
  // Deliberately a model the Architect is *not* authoring with, so what a
  // created Agent runs on can be told apart from what wrote its file.
  //
  // The Close below belongs to the Settings dialog itself
  // (`ui/components/ui/dialog.tsx:67-83`), not to a nested connection dialog —
  // `provider-settings.tsx:221-295` edits inline. So this has to happen first,
  // or the control is disappearing with the dialog while it is being clicked.
  if (setDefaultTo) {
    // By role: the "Enable Fixture App Default Model" switch also matches the
    // accessible name "Default model" as a substring.
    const defaultModel = page.getByRole("button", { name: "Default model", exact: true });
    await expect(defaultModel).toBeEnabled({ timeout: 30_000 });
    await defaultModel.click();
    // The option's accessible name carries the model's context length as well
    // as its label (`model-select.tsx:213-234`), so this matches the label as
    // text inside the open picker rather than as the whole name.
    await page
      .getByRole("option")
      .filter({ hasText: setDefaultTo })
      .first()
      .click();
    await expect(defaultModel).toContainText(setDefaultTo);
  }
  const close = page.getByRole("button", { name: "Close", exact: true });
  await close.click();
  await expect(close).toBeHidden();
}

function persona(name: string, marker = personaMarker(name)) {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description.`,
    "tier: specialist",
    "provider: openai",
    "model: fixture/resource-architect",
    "thinking: medium",
    "tools: none",
    "---",
    "",
    `# ${name}`,
    "",
    marker,
    "",
  ].join("\n");
}

async function startResourceProvider(options: {
  /** A skill whose first author request is refused with a server error. */
  failSkillAuthorOnce?: string;
} = {}): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  generationRequests(): number;
  /** The generation request for this planned Agent, once one arrives. */
  generationPromptFor(name: string): Promise<string>;
  skillAuthorRequests(): number;
  /** The skill each author request named, in arrival order. */
  skillAuthorNames(): string[];
  /** Whether a tool result carrying the authored skill body reached this server. */
  loadedSkillMarkerObserved(): boolean;
  /** What the Agent catalog was missing, when the runtime could not load. */
  catalogGap(): string | null;
  releaseGeneration(): void;
  /** The distinct models this Agent's own turns named, by persona marker. */
  modelsDispatchedFor(marker: string): string[];
}> {
  const chatRequests: Array<{ model: string; system: string }> = [];
  let generationRequests = 0;
  const generationPrompts = new Map<string, string>();
  const generationPromptWaiters = new Map<string, Array<(prompt: string) => void>>();
  let generationReleased = false;
  let skillAuthorRequests = 0;
  const skillAuthorNames: string[] = [];
  let skillAuthorFailureSent = false;
  let loadedSkillMarkerObserved = false;
  let observedCatalogGap: string | null = null;
  const blocked = new Set<() => void>();
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          data: [
            {
              id: AUTHORING_MODEL.id,
              name: AUTHORING_MODEL.name,
              context_length: 32_000,
            },
            // Deliberately a different id from the authoring model. If the two
            // were the same, a run assertion could not tell "ran on the app
            // default" from "ran on whatever wrote the file".
            {
              id: APP_DEFAULT_MODEL.id,
              name: APP_DEFAULT_MODEL.name,
              context_length: 32_000,
            },
          ],
        }));
        return;
      }
      // Both endpoints this fixture can legitimately be asked for. A persona
      // that names `provider: openai` is dispatched to `/v1/responses`
      // (`providers/openai.ts`), and `OPENAI_BASE_URL` points here — so
      // serving only chat completions would turn a persona that kept its pair
      // into an unrecorded 404 and a timeout, instead of a visible wrong model.
      const responsesEndpoint =
        request.method === "POST" && request.url === "/v1/responses";
      if (
        !responsesEndpoint &&
        (request.method !== "POST" || request.url !== "/v1/chat/completions")
      ) {
        response.writeHead(404).end("not found");
        return;
      }
      if (responsesEndpoint) {
        const responsesChunks: Buffer[] = [];
        for await (const chunk of request) responsesChunks.push(Buffer.from(chunk));
        const responsesBody = JSON.parse(
          Buffer.concat(responsesChunks).toString("utf8"),
        ) as { model?: string; instructions?: string; input?: unknown };
        const responsesSystem = typeof responsesBody.instructions === "string"
          ? responsesBody.instructions
          : JSON.stringify(responsesBody.input ?? "");
        if (!isAuthoringRequest(responsesSystem)) {
          chatRequests.push({
            model: responsesBody.model ?? "",
            system: responsesSystem,
          });
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          model: responsesBody.model ?? "",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The member has answered." }],
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model?: string;
        messages?: Array<{ role?: string; content?: string }>;
      };
      const system = body.messages?.find((message) => message.role === "system")
        ?.content ?? "";
      // Authoring is recognised positively, and everything else is a member's
      // own turn. It cannot be the other way round: the Agent Architect embeds
      // whole existing personas as exemplars, so an authoring request can
      // legitimately quote a generated Agent's marker. Routing or recording on
      // the marker alone would read that as the Agent having run.
      const authoring = isAuthoringRequest(system);
      if (!authoring) chatRequests.push({ model: body.model ?? "", system });
      const lastUser = [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "";
      const allUserText = (body.messages ?? [])
        .filter((message) => message.role === "user")
        .map((message) => message.content ?? "")
        .join("\n");
      const runningMember = authoring
        ? undefined
        : plannedNames.find((name) => system.includes(personaMarker(name)));
      if (runningMember) {
        sendChat(response, `${displayName(runningMember)} has reviewed the contract.`);
        return;
      }
      if (system.includes("CONVERSATION_RESPONSE_POLICY")) {
        if (allUserText.includes(UPLOAD_RUN_ORDER_MARKER)) {
          sendChat(response, uploadedFileAnswer(body.messages ?? []));
          return;
        }
        if (/exact run order/i.test(lastUser)) {
          sendChat(response, answerFromSelectedPackage(system));
          return;
        }
        if (/^build it$/i.test(lastUser.trim())) {
          sendChat(
            response,
            "Understood — preparing the proposal for your review.\n[[proposal-requested]]",
          );
          return;
        }
        sendChat(
          response,
          /\bteam\b/i.test(allUserText)
            ? "I have enough information to prepare a Team proposal."
            : "I have enough information to prepare an Agent proposal.",
        );
        return;
      }
      if (system.includes("RESOURCE_ARCHITECT_RESPONSE_SCHEMA")) {
        if (
          /\badd\b/i.test(allUserText) &&
          new RegExp(displayName(UPDATE_TEAM_ID), "i").test(allUserText) &&
          new RegExp(CREATED_TEAM_NEW_AGENT, "i").test(allUserText)
        ) {
          sendChat(response, JSON.stringify({
            message: `I will create ${CREATED_TEAM_NEW_AGENT} and add it to ${UPDATE_TEAM_ID}.`,
            outcome: {
              id: "electron-created-team-update-plan",
              kind: "resource_updates",
              operations: [{
                kind: "add_team_agents",
                target: { kind: "team", id: UPDATE_TEAM_ID },
                libraryAgentsToAdd: [],
                newAgentsToCreate: [{
                  name: CREATED_TEAM_NEW_AGENT,
                  role: "Regulatory change reviewer",
                  tier: "strategic",
                  summary: "Flags contract terms that recent regulatory changes affect.",
                  description: "Checks contracts against regulatory changes.",
                  rationale: "The created Team does not yet cover regulatory change.",
                  documentSpecialization: null,
                }],
              }],
            },
            warnings: [],
          }));
          return;
        }
        // An explicit request naming an existing Team id is an update, not a
        // creation. No revision is sent: the server owns that.
        if (
          /\badd\b/i.test(allUserText) &&
          new RegExp(UPDATE_TEAM_ID, "i").test(allUserText)
        ) {
          sendChat(response, JSON.stringify({
            message: `I will add two Agents to ${UPDATE_TEAM_ID}.`,
            outcome: {
              id: "electron-team-update-plan",
              kind: "resource_updates",
              operations: [{
                kind: "add_team_agents",
                target: { kind: "team", id: UPDATE_TEAM_ID },
                libraryAgentsToAdd: [{
                  name: UPDATE_LIBRARY_AGENT,
                  role: "Scope reviewer",
                  tier: "strategic",
                  rationale: "Reuse the existing scope specialist.",
                }],
                newAgentsToCreate: [{
                  name: UPDATE_NEW_AGENT,
                  role: "Drafting completeness reviewer",
                  tier: "strategic",
                  summary: "Finds drafting gaps before a contract is signed.",
                  description: "Checks drafting completeness.",
                  rationale: "No existing Agent covers drafting gaps.",
                  documentSpecialization: null,
                }],
              }],
            },
            warnings: [],
          }));
          return;
        }
        // Three skills on one existing Agent, for the partial-authoring journey.
        // A skill update creates no Agent, so the plan carries no Agent brief.
        if (new RegExp(SKILL_THIRD, "i").test(allUserText)) {
          sendChat(response, JSON.stringify({
            message: `I will change three skills on ${SKILL_AGENT}.`,
            outcome: {
              id: "electron-agent-partial-skill-update-plan",
              kind: "resource_updates",
              operations: [{
                kind: "update_agent_skills",
                target: { kind: "agent", id: SKILL_AGENT },
                skillUpdates: [
                  {
                    action: "create",
                    name: SKILL_NEW,
                    instruction: "Author a termination-clause review covering notice and cure rights.",
                  },
                  {
                    action: "update",
                    name: SKILL_EXISTING,
                    instruction: "Rewrite the indemnity review to require a liability cap check.",
                  },
                  {
                    action: "create",
                    name: SKILL_THIRD,
                    instruction: "Author a cure-period review that checks each notice window.",
                  },
                ],
              }],
            },
            warnings: [],
          }));
          return;
        }
        // An explicit request naming an existing Agent and its skills is a
        // skill update, not a creation. No revision is sent: the server owns it.
        if (
          /\bskill\b/i.test(allUserText) &&
          new RegExp(SKILL_AGENT, "i").test(allUserText)
        ) {
          sendChat(response, JSON.stringify({
            message: `I will change two skills on ${SKILL_AGENT}.`,
            outcome: {
              id: "electron-agent-skill-update-plan",
              kind: "resource_updates",
              operations: [{
                kind: "update_agent_skills",
                target: { kind: "agent", id: SKILL_AGENT },
                skillUpdates: [
                  {
                    action: "create",
                    name: SKILL_NEW,
                    instruction: "Author a termination-clause review covering notice and cure rights.",
                  },
                  {
                    action: "update",
                    name: SKILL_EXISTING,
                    instruction: "Rewrite the indemnity review to require a liability cap check.",
                  },
                ],
              }],
            },
            warnings: [],
          }));
          return;
        }
        if (allUserText.includes(LONG_BRIEF_REQUEST)) {
          sendChat(response, JSON.stringify({
            message: `Proposal ready for review: ${LONG_BRIEF_AGENT}.`,
            outcome: {
              id: "electron-long-brief-plan",
              kind: "standalone_agents",
              agents: [{
                name: LONG_BRIEF_AGENT,
                role: "Supplier contract auditor",
                summary: LONG_BRIEF_SUMMARY,
                description: LONG_BUILD_BRIEF,
                rationale: "Requested to audit supplier agreements before signature.",
                webResearchEnabled: false,
              }],
            },
            warnings: [],
          }));
          return;
        }
        const teamRequested = /\bteam\b/i.test(allUserText);
        sendChat(response, JSON.stringify({
          message: teamRequested
            ? "Proposal ready for review: contract review team."
            : "Proposal ready for review: three standalone lawyers.",
          outcome: teamRequested
            ? {
                id: "electron-lawyers-team-plan",
                kind: "team",
                team: {
                  teamId: "contract-review-team",
                  description: "Reviews contracts from complementary legal perspectives.",
                  tags: ["legal"],
                  existingAgents: [],
                  newAgents: plannedNames.map((name) => ({
                    name,
                    role: `${name} reviewer`,
                    tier: "specialist",
                    summary: `Reviews contracts as the ${name}.`,
                    description: `${name} contract reviewer.`,
                    rationale: "Requested for the contract review team.",
                  })),
                  questionsResolved: ["three complementary reviewers"],
                },
              }
            : {
                id: "electron-lawyers-plan",
                kind: "standalone_agents",
                agents: plannedNames.map((name) => ({
                  name,
                  role: `${name} reviewer`,
                  tier: "specialist",
                  summary: `Reviews contracts as the ${name}.`,
                  description: `${name} contract reviewer.`,
                  rationale: "Requested as an independent reviewer.",
                  webResearchEnabled: name !== "drafting-completeness-lawyer",
                })),
              },
          warnings: [],
        }));
        return;
      }

      // The Agent runtime. Its system prompt carries the skill catalog the
      // real loader built from the Agent package on disk, so the exact source
      // and hash of the skill this update published are read from there rather
      // than guessed. The catalog never contains the skill body, so the
      // authored marker can only reach this server inside a tool result.
      if (system.includes(SKILL_LOADER_TOOL)) {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        if (rawBody.includes(SKILL_AUTHORED_MARKER)) {
          loadedSkillMarkerObserved = true;
          sendChat(response, RUNTIME_ANSWER);
          return;
        }
        const entry = system
          .split("### ")
          .find((section) => section.startsWith(`${SKILL_NEW}\n`));
        const source = entry?.match(/^source:\s*(.+)$/m)?.[1]?.trim();
        const sha256 = entry?.match(/^sha256:\s*([a-f0-9]{64})$/m)?.[1];
        if (!source || !sha256) {
          observedCatalogGap = `catalog missing ${SKILL_NEW}: ${
            entry ? "no source/sha256" : "no entry"
          }`;
          sendChat(response, observedCatalogGap);
          return;
        }
        sendToolCall(response, SKILL_LOADER_TOOL, { source, sha256 });
        return;
      }

      // The skill author writes one SKILL.md at a time and is told which
      // folder it is for. Answered immediately: what the journey watches is
      // whether the call happened at all before the user applied the update.
      if (system.trimStart().startsWith("# Skill Author")) {
        const skillName = lastUser.match(/Skill folder name:\s*`([^`]+)`/i)?.[1];
        if (!skillName) {
          response.writeHead(500).end("skill folder name missing");
          return;
        }
        skillAuthorRequests += 1;
        skillAuthorNames.push(skillName);
        if (skillName === options.failSkillAuthorOnce && !skillAuthorFailureSent) {
          skillAuthorFailureSent = true;
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("the skill author stalled");
          return;
        }
        sendChat(response, JSON.stringify({
          name: skillName,
          body: authoredSkillDocument(skillName, skillAuthorRequests),
        }));
        return;
      }

      const plannedName =
        lastUser.match(/Planned Agent name:\s*`([^`]+)`/i)?.[1] ??
        lastUser.match(/Create the missing agent\s+`([^`]+)`/i)?.[1];
      if (!plannedName) {
        response.writeHead(500).end("planned name missing");
        return;
      }
      generationRequests += 1;
      if (!generationPrompts.has(plannedName)) {
        generationPrompts.set(plannedName, lastUser);
        for (const resolve of generationPromptWaiters.get(plannedName) ?? []) resolve(lastUser);
        generationPromptWaiters.delete(plannedName);
      }
      const reply = () => {
        blocked.delete(reply);
        sendChat(response, JSON.stringify({
          message: `Created ${plannedName}.`,
          suggestedName: plannedName,
          personaMarkdown: persona(plannedName),
          generatedSkills: [{
            name: `${plannedName}-review`,
            body: `---\nname: ${plannedName}-review\ndescription: Review a draft against the method. Use when a draft needs a structured review pass.\n---\n\n# Review\n`,
          }],
        }));
      };
      if (generationReleased) reply();
      else blocked.add(reply);
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider address unavailable");
  const releaseGeneration = () => {
    generationReleased = true;
    for (const reply of [...blocked]) reply();
  };
  return {
    skillAuthorRequests: () => skillAuthorRequests,
    skillAuthorNames: () => [...skillAuthorNames],
    loadedSkillMarkerObserved: () => loadedSkillMarkerObserved,
    catalogGap: () => observedCatalogGap,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    generationRequests: () => generationRequests,
    generationPromptFor: (name: string) => {
      const seen = generationPrompts.get(name);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise<string>((resolve) => {
        generationPromptWaiters.set(name, [...(generationPromptWaiters.get(name) ?? []), resolve]);
      });
    },
    modelsDispatchedFor: (marker: string) => [
      ...new Set(
        chatRequests
          .filter((entry) => entry.system.includes(marker))
          .map((entry) => entry.model),
      ),
    ],
    releaseGeneration,
    close: () => new Promise<void>((resolve, reject) => {
      releaseGeneration();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

/** One assistant turn that calls a tool instead of answering. */
function sendToolCall(
  response: http.ServerResponse,
  name: string,
  args: Record<string, unknown>,
): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    model: "fixture/resource-architect",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  }));
}

function sendChat(response: http.ServerResponse, content: string): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    model: "fixture/resource-architect",
    choices: [{ message: { role: "assistant", content } }],
  }));
}
