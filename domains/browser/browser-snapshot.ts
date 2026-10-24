/// <reference lib="dom" />

import { randomUUID } from "node:crypto";

import type { ElementHandle, Frame, Page } from "puppeteer-core";

import type {
  BrowserContentBlockView,
  BrowserElementView,
  BrowserFrameView,
  BrowserVisualFallbackView,
} from "./browser-types.js";

const MAX_ELEMENTS = 200;
const MAX_BLOCKS = 200;
const MAX_FRAME_TEXT_CHARS = 2_000_000;

export interface CapturedBrowserSnapshot {
  readonly snapshotId: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly elements: readonly BrowserElementView[];
  readonly blocks: readonly BrowserContentBlockView[];
  readonly frames: readonly BrowserFrameView[];
  readonly refs: ReadonlyMap<string, ElementHandle<Element>>;
  readonly visual: BrowserVisualFallbackView;
}

interface FramePayload {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly elements: readonly Omit<BrowserElementView, "ref" | "frameId">[];
  readonly blocks: readonly {
    readonly type: BrowserContentBlockView["type"];
    readonly text: string;
    readonly level?: number;
  }[];
  readonly canvasCount: number;
  readonly unlabeledImageCount: number;
}

export async function captureBrowserSnapshot(
  page: Page,
  frameAllowed: (url: string) => Promise<boolean>,
): Promise<CapturedBrowserSnapshot> {
  const snapshotId = `snap-${randomUUID()}`;
  const frames: BrowserFrameView[] = [];
  const elements: BrowserElementView[] = [];
  const blocks: BrowserContentBlockView[] = [];
  const refs = new Map<string, ElementHandle<Element>>();
  const textParts: string[] = [];
  let mainTitle = "";
  let mainUrl = page.url();
  let canvasCount = 0;
  let unlabeledImageCount = 0;

  for (const [frameIndex, frame] of page.frames().entries()) {
    const frameId = `f${frameIndex}`;
    const frameUrl = frame.url() || "about:blank";
    const allowed =
      frame === page.mainFrame() || frameUrl === "about:blank"
        ? true
        : await frameAllowed(frameUrl);
    if (!allowed) {
      frames.push({ frameId, url: frameUrl, title: "", allowed: false });
      continue;
    }
    let captured: Awaited<ReturnType<typeof captureFrame>>;
    try {
      captured = await captureFrame(frame);
    } catch {
      if (frame === page.mainFrame())
        throw new Error("The main browser frame could not be observed.");
      frames.push({ frameId, url: frameUrl, title: "", allowed: false });
      continue;
    }
    frames.push({
      frameId,
      url: captured.payload.url,
      title: captured.payload.title,
      allowed: true,
    });
    if (frame === page.mainFrame()) {
      mainTitle = captured.payload.title;
      mainUrl = captured.payload.url;
    }
    canvasCount += captured.payload.canvasCount;
    unlabeledImageCount += captured.payload.unlabeledImageCount;
    const prefix =
      frame === page.mainFrame()
        ? ""
        : `\n\n[Frame ${frameId}: ${captured.payload.title || captured.payload.url}]\n`;
    if (captured.payload.text.trim())
      textParts.push(prefix + captured.payload.text.trim());

    const accessibleElements = await enrichWithAccessibility(
      page,
      frame,
      captured.handles,
      captured.payload.elements,
    );
    accessibleElements.forEach((element, index) => {
      const handle = captured.handles[index];
      if (!handle) return;
      const ref = `${snapshotId}:${frameId}:e${index + 1}`;
      refs.set(ref, handle);
      elements.push({ ...element, ref, frameId });
    });
    captured.payload.blocks.forEach((block, index) => {
      blocks.push({
        id: `${snapshotId}:${frameId}:b${index + 1}`,
        frameId,
        ...block,
      });
    });
  }

  const text = textParts.join("").slice(0, MAX_FRAME_TEXT_CHARS);
  const reasons: string[] = [];
  if (canvasCount > 0)
    reasons.push(
      `${canvasCount} canvas element${canvasCount === 1 ? "" : "s"}`,
    );
  if (unlabeledImageCount > 0)
    reasons.push(
      `${unlabeledImageCount} unlabeled image${unlabeledImageCount === 1 ? "" : "s"}`,
    );
  if (text.trim().length < 80 && (canvasCount > 0 || unlabeledImageCount > 0)) {
    reasons.push("little semantic text");
  }
  return {
    snapshotId,
    title: mainTitle,
    url: mainUrl,
    text,
    elements,
    blocks,
    frames,
    refs,
    visual: {
      recommended: reasons.length > 0,
      reasons,
      screenshotSupported: true,
    },
  };
}

async function enrichWithAccessibility(
  page: Page,
  frame: Frame,
  handles: readonly ElementHandle<Element>[],
  elements: readonly Omit<BrowserElementView, "ref" | "frameId">[],
): Promise<readonly Omit<BrowserElementView, "ref" | "frameId">[]> {
  const session = await page.createCDPSession();
  try {
    const frameId =
      frame === page.mainFrame() ? undefined : (frame as { _id?: string })._id;
    const tree = await session.send(
      "Accessibility.getFullAXTree",
      frameId ? { frameId } : {},
    );
    const byBackendId = new Map<number, (typeof tree.nodes)[number]>();
    for (const node of tree.nodes) {
      if (node.backendDOMNodeId !== undefined && !node.ignored) {
        byBackendId.set(node.backendDOMNodeId, node);
      }
    }
    const backendIds = await Promise.all(
      handles.map((handle) => handle.backendNodeId().catch(() => -1)),
    );
    return elements.map((element, index) => {
      const node = byBackendId.get(backendIds[index] ?? -1);
      if (!node) return element;
      const properties = new Map(
        (node.properties ?? []).map((property) => [
          property.name,
          property.value.value,
        ]),
      );
      const role =
        typeof node.role?.value === "string" ? node.role.value : element.role;
      const name =
        typeof node.name?.value === "string" && node.name.value.trim()
          ? node.name.value.trim().replace(/\s+/g, " ").slice(0, 240)
          : element.name;
      return {
        ...element,
        name,
        ...(role ? { role } : {}),
        ...(typeof properties.get("disabled") === "boolean"
          ? { disabled: properties.get("disabled") as boolean }
          : {}),
        ...(typeof properties.get("checked") === "boolean"
          ? { checked: properties.get("checked") as boolean }
          : {}),
        ...(typeof properties.get("selected") === "boolean"
          ? { selected: properties.get("selected") as boolean }
          : {}),
        ...(typeof properties.get("expanded") === "boolean"
          ? { expanded: properties.get("expanded") as boolean }
          : {}),
      };
    });
  } catch {
    return elements;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function captureFrame(
  frame: Frame,
): Promise<{
  readonly payload: FramePayload;
  readonly handles: readonly ElementHandle<Element>[];
}> {
  try {
    // tsx/esbuild preserves local function names through a small `__name`
    // helper. Browser evaluation runs in a separate realm, so install the
    // helper only for the duration of this extraction and remove it below.
    await frame.evaluate("globalThis.__name = (value) => value");
    const result = await frame.evaluateHandle(
      (limits) => {
        const all: HTMLElement[] = [];
        const visit = (root: Document | ShadowRoot) => {
          for (const element of root.querySelectorAll<HTMLElement>("*")) {
            all.push(element);
            if (element.shadowRoot) visit(element.shadowRoot);
          }
        };
        visit(document);

        const visible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity || "1") !== 0 &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const roleFor = (element: HTMLElement): string | undefined => {
          const explicit = element.getAttribute("role")?.trim();
          if (explicit) return explicit;
          const tag = element.tagName.toLowerCase();
          if (tag === "a" && element.hasAttribute("href")) return "link";
          if (tag === "button") return "button";
          if (tag === "textarea") return "textbox";
          if (tag === "select") return "combobox";
          if (tag === "input") {
            const type = (element.getAttribute("type") || "text").toLowerCase();
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            if (["button", "submit", "reset"].includes(type)) return "button";
            return "textbox";
          }
          return undefined;
        };
        const nameFor = (element: HTMLElement): string => {
          const labelledBy = element
            .getAttribute("aria-labelledby")
            ?.split(/\s+/)
            .map(
              (id) =>
                element.ownerDocument.getElementById(id)?.textContent ?? "",
            )
            .join(" ")
            .trim();
          const labels =
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
              ? [...(element.labels ?? [])]
                  .map((label) => label.innerText)
                  .join(" ")
                  .trim()
              : "";
          return (
            element.getAttribute("aria-label") ||
            labelledBy ||
            labels ||
            (element instanceof HTMLImageElement ? element.alt : "") ||
            element.getAttribute("title") ||
            (element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
              ? element.placeholder
              : "") ||
            element.innerText ||
            element.textContent ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 240);
        };
        const actionable = all
          .filter((element) => {
            const tag = element.tagName.toLowerCase();
            return (
              visible(element) &&
              ((tag === "a" && element.hasAttribute("href")) ||
                ["button", "input", "textarea", "select"].includes(tag) ||
                [
                  "button",
                  "link",
                  "checkbox",
                  "radio",
                  "textbox",
                  "combobox",
                  "menuitem",
                  "tab",
                ].includes(element.getAttribute("role") ?? "") ||
                element.isContentEditable ||
                element.hasAttribute("onclick") ||
                (element.hasAttribute("tabindex") &&
                  element.getAttribute("tabindex") !== "-1"))
            );
          })
          .slice(0, limits.maxElements);
        const elements = actionable.map((element) => {
          const input =
            element instanceof HTMLInputElement ? element : undefined;
          const option =
            element instanceof HTMLOptionElement ? element : undefined;
          const anchor =
            element instanceof HTMLAnchorElement
              ? element
              : element.closest("a");
          const role = roleFor(element);
          const type = element.getAttribute("type");
          return {
            tag: element.tagName.toLowerCase(),
            name: nameFor(element),
            ...(role ? { role } : {}),
            ...(type ? { type: type.toLowerCase() } : {}),
            ...(anchor?.href ? { href: anchor.href } : {}),
            ...("disabled" in element &&
            Boolean((element as HTMLButtonElement).disabled)
              ? { disabled: true }
              : {}),
            ...(input?.checked !== undefined &&
            ["checkbox", "radio"].includes(input.type)
              ? { checked: input.checked }
              : {}),
            ...(option ? { selected: option.selected } : {}),
            ...(element.hasAttribute("aria-expanded")
              ? { expanded: element.getAttribute("aria-expanded") === "true" }
              : {}),
          };
        });

        const blockTags = new Set([
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "p",
          "li",
          "blockquote",
          "pre",
          "table",
        ]);
        const blocks = all
          .filter(
            (element) =>
              blockTags.has(element.tagName.toLowerCase()) && visible(element),
          )
          .slice(0, limits.maxBlocks)
          .map((element) => {
            const tag = element.tagName.toLowerCase();
            let text = element.innerText.trim().replace(/[ \t]+/g, " ");
            if (tag === "table") {
              text = [...element.querySelectorAll("tr")]
                .map((row) =>
                  [...row.querySelectorAll("th,td")]
                    .map((cell) =>
                      (cell as HTMLElement).innerText
                        .trim()
                        .replace(/\s+/g, " "),
                    )
                    .join(" | "),
                )
                .filter(Boolean)
                .join("\n");
            }
            const type = tag.startsWith("h")
              ? "heading"
              : tag === "li"
                ? "list_item"
                : tag === "table"
                  ? "table"
                  : tag === "blockquote"
                    ? "quote"
                    : tag === "pre"
                      ? "code"
                      : "paragraph";
            return {
              type,
              text: text.slice(0, 4_000),
              ...(type === "heading" ? { level: Number(tag.slice(1)) } : {}),
            };
          })
          .filter((block) => block.text.length > 0);

        return {
          nodes: actionable,
          payload: {
            title: document.title,
            url: location.href,
            text: (document.body?.innerText ?? "").slice(
              0,
              limits.maxTextChars,
            ),
            elements,
            blocks,
            canvasCount: all.filter(
              (element) => element.tagName.toLowerCase() === "canvas",
            ).length,
            unlabeledImageCount: all.filter(
              (element) =>
                element instanceof HTMLImageElement &&
                visible(element) &&
                !element.alt.trim(),
            ).length,
          },
        };
      },
      {
        maxElements: MAX_ELEMENTS,
        maxBlocks: MAX_BLOCKS,
        maxTextChars: MAX_FRAME_TEXT_CHARS,
      },
    );
    const payloadHandle = await result.getProperty("payload");
    const nodesHandle = await result.getProperty("nodes");
    const payload = (await payloadHandle.jsonValue()) as FramePayload;
    const properties = await nodesHandle.getProperties();
    const handles: ElementHandle<Element>[] = [];
    for (let index = 0; index < payload.elements.length; index += 1) {
      const element = properties.get(String(index))?.asElement();
      if (element) handles.push(element as ElementHandle<Element>);
    }
    await Promise.all([
      payloadHandle.dispose(),
      nodesHandle.dispose(),
      result.dispose(),
    ]);
    await frame.evaluate("delete globalThis.__name").catch(() => undefined);
    return { payload, handles };
  } catch (error) {
    await frame.evaluate("delete globalThis.__name").catch(() => undefined);
    throw error;
  }
}
