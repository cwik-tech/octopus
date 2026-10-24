import { createHash } from "node:crypto";

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  type ResearchCitationCanonicalizationSummary,
  type ResearchCitationRemoval,
  type ResearchCitationRemovalKind,
  type ResearchEvidenceGraph,
} from "../../contracts/deep-research.js";
import { parseResearchEvidenceGraph } from "./deep-research-evidence-graph.js";
import {
  extractRawCitationUrls,
  isSourceSectionHeading,
  normalizeCitationUrl,
  stripCitationUrls,
} from "./deep-research-publication-audit.js";

const HEADING_TEXT_PATTERN = /^#{1,6}\s+(.+?)\s*#*$/u;
const DEFINITION_URL_PATTERN = /^(\s*\[[^\]]*\]:\s*)(\S+)([\s\S]*)$/u;
const PROSE_PATTERN = /[\p{L}\p{N}]/u;

/** Label used when a footnote citation carries no editorial link text. */
const DEFAULT_FOOTNOTE_LABEL = "citation";
/** Separator between several inline links replacing one footnote marker. */
const FOOTNOTE_LINK_SEPARATOR = " ";

export interface ResearchCitationCanonicalizationResult {
  readonly markdown: string;
  readonly summary: ResearchCitationCanonicalizationSummary;
}

interface CatalogEntry {
  readonly url: string;
  readonly title: string;
  readonly sourceIds: readonly string[];
}

interface MarkdownNode {
  readonly type: string;
  readonly url?: string;
  readonly value?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
  readonly start: number;
  readonly end: number;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface FootnoteCitation {
  readonly label: string;
  readonly url: string;
}

interface FootnotePlan {
  readonly identifier: string;
  /** Canonical inline links that replace every reference to this footnote. */
  readonly citations: readonly FootnoteCitation[];
  /** Definition text to keep, or undefined when the definition is removed. */
  readonly definitionText: string | undefined;
  readonly definitionStart: number;
  readonly definitionEnd: number;
}

/**
 * Rewrites editorial citations against the evidence graph: known URLs are
 * canonicalized in place, unknown URLs are removed, and one runtime-owned
 * `## Sources` section replaces any model-authored source section.
 *
 * Editorial link labels are deliberately preserved. Runtime titles appear only
 * in the generated Sources section, which claim-text extraction excludes, so
 * canonicalization cannot introduce claim numerals or drop caveat words.
 */
export function canonicalizeResearchCitations(input: {
  readonly markdown: string;
  readonly evidenceGraph: unknown;
}): ResearchCitationCanonicalizationResult {
  const graph = parseResearchEvidenceGraph(input.evidenceGraph);
  const catalog = buildCitationCatalog(graph);
  const catalogByUrl = new Map(catalog.map((entry) => [entry.url, entry]));
  assertSupportedClaimsAreUsable(graph, catalog);

  const source = input.markdown;
  const root = parseMarkdown(source);
  const removals: ResearchCitationRemoval[] = [];
  const edits: Edit[] = [];
  let normalizedLinkCount = 0;

  const sections = findSourceSections(root, source);
  const inRemovedSection = (offset: number): boolean =>
    sections.some(
      (section) => offset >= section.start && offset < section.end,
    );

  const footnotePlans = new Map<string, FootnotePlan>();
  const duplicateFootnoteIdentifiers = new Set<string>();
  for (const node of root.children ?? []) {
    if (node.type !== "footnoteDefinition") continue;
    const identifier = node.identifier;
    if (identifier === undefined) continue;
    if (footnotePlans.has(identifier)) {
      // GFM resolves a reference to the first matching definition, so later
      // duplicates are dead weight; they must not keep their URLs either.
      duplicateFootnoteIdentifiers.add(identifier);
      recordUnknownUrlsInFootnote({ node, catalogByUrl, removals });
      edits.push(deleteBlock(source, node.start, node.end));
      continue;
    }
    footnotePlans.set(
      identifier,
      planFootnote({ node, source, catalogByUrl, removals, identifier }),
    );
  }

  // A definition whose references were all removed (or never existed) renders
  // as an orphaned note, so it follows its references instead of surviving.
  const liveFootnoteReferences = new Set<string>();
  visit(root, (node, parents) => {
    if (isSkippedContainer(node)) return false;
    if (
      node.type === "footnoteReference" &&
      node.identifier !== undefined &&
      !inRemovedSection(node.start)
    ) {
      // A reference inside a dropped duplicate definition dies with its
      // container, so it cannot keep another footnote definition alive.
      const enclosingIdentifier = parents.find(
        (parent) => parent.type === "footnoteDefinition",
      )?.identifier;
      if (
        enclosingIdentifier === undefined ||
        !duplicateFootnoteIdentifiers.has(enclosingIdentifier)
      ) {
        liveFootnoteReferences.add(node.identifier);
      }
    }
    return true;
  });

  // Footnote definitions are relocated out of a removed source section so a
  // model-authored "References" heading cannot take explanatory notes with it.
  const relocatedFootnotes: string[] = [];
  for (const plan of [...footnotePlans.values()].sort(
    (left, right) => left.definitionStart - right.definitionStart,
  )) {
    const inside = inRemovedSection(plan.definitionStart);
    if (!liveFootnoteReferences.has(plan.identifier)) {
      if (!inside) {
        edits.push(deleteBlock(source, plan.definitionStart, plan.definitionEnd));
      }
      continue;
    }
    if (plan.definitionText === undefined) {
      if (!inside) {
        edits.push(deleteBlock(source, plan.definitionStart, plan.definitionEnd));
      }
      continue;
    }
    if (inside) {
      relocatedFootnotes.push(plan.definitionText);
      continue;
    }
    edits.push({
      start: plan.definitionStart,
      end: plan.definitionEnd,
      text: plan.definitionText,
    });
  }

  const unknownDefinitionUrls = new Map<string, string>();
  const seenDefinitionIdentifiers = new Set<string>();
  visit(root, (node, parents) => {
    if (isSkippedContainer(node)) return false;
    if (parents.some((parent) => parent.type === "footnoteDefinition")) {
      return true;
    }
    if (inRemovedSection(node.start)) return true;

    if (node.type === "footnoteReference") {
      const plan =
        node.identifier === undefined
          ? undefined
          : footnotePlans.get(node.identifier);
      if (!plan) return true;
      if (plan.citations.length === 0) {
        // Nothing validated survived; an explanatory note keeps its marker.
        if (plan.definitionText === undefined) {
          edits.push(removeInline(source, node.start, node.end));
        }
        return true;
      }
      const links = plan.citations
        .map(
          (citation) =>
            `[${escapeLabel(citation.label)}](${emitLinkDestination(citation.url)})`,
        )
        .join(FOOTNOTE_LINK_SEPARATOR);
      normalizedLinkCount += plan.citations.length;
      edits.push({
        start: node.start,
        end: node.end,
        // A surviving explanatory note keeps its marker after the citations.
        text:
          plan.definitionText === undefined
            ? links
            : `${links} ${source.slice(node.start, node.end)}`,
      });
      return true;
    }

    if (node.type === "definition") {
      const identifier = node.identifier;
      const isDuplicate =
        identifier !== undefined &&
        seenDefinitionIdentifiers.has(identifier);
      if (identifier !== undefined) {
        seenDefinitionIdentifiers.add(identifier);
      }
      if (isDuplicate) {
        // CommonMark resolves a reference to the first matching definition,
        // so a later duplicate is dead weight: it follows the duplicate
        // footnote rule and can never shadow the first definition's
        // resolution of a reference.
        if (node.url !== undefined && isHttpUrl(node.url)) {
          const duplicateUrl = normalizeCitationUrl(node.url);
          if (!catalogByUrl.has(duplicateUrl)) {
            removals.push({
              url: duplicateUrl,
              kind: "reference_definition",
              offset: node.start,
            });
          }
        }
        edits.push(deleteBlock(source, node.start, node.end));
        return true;
      }
      const rewritten = rewriteDefinition({ node, source, catalogByUrl });
      if (rewritten === undefined) return true;
      if (rewritten.removed) {
        if (identifier !== undefined) {
          unknownDefinitionUrls.set(identifier, rewritten.url);
        }
        removals.push({
          url: rewritten.url,
          kind: "reference_definition",
          offset: node.start,
        });
        edits.push(deleteBlock(source, node.start, node.end));
      } else {
        normalizedLinkCount += 1;
        edits.push({ start: node.start, end: node.end, text: rewritten.text });
      }
      return true;
    }

    if (node.type === "link") {
      const edit = rewriteLink({ node, source, catalogByUrl, removals });
      if (edit) {
        edits.push(edit.edit);
        if (edit.normalized) normalizedLinkCount += 1;
      }
      return true;
    }

    return true;
  });

  // A reference whose definition was an unknown URL degrades to its own
  // label, with the same URL-leak protection as removed inline links.
  if (unknownDefinitionUrls.size > 0) {
    visit(root, (node, parents) => {
      if (isSkippedContainer(node)) return false;
      if (parents.some((parent) => parent.type === "footnoteDefinition")) {
        return true;
      }
      if (inRemovedSection(node.start)) return true;
      if (node.type !== "linkReference") return true;
      const removedUrl =
        node.identifier === undefined
          ? undefined
          : unknownDefinitionUrls.get(node.identifier);
      if (!removedUrl) return true;
      const preserved = preservedLabelText(innerText(node, source), removedUrl);
      edits.push(
        preserved
          ? { start: node.start, end: node.end, text: preserved }
          : removeInline(source, node.start, node.end),
      );
      return true;
    });
  }

  for (const section of sections) {
    edits.push(deleteBlock(source, section.start, section.end));
  }

  const body = applyEdits(source, edits).replace(/\s+$/u, "");
  const markdown = appendGeneratedSources({
    body,
    catalog,
    relocatedFootnotes,
  });

  return {
    markdown,
    summary: {
      inputSha256: sha256(input.markdown),
      outputSha256: sha256(markdown),
      graphUrlBaseline: catalog.map((entry) => entry.url),
      publicationUrlInventory: collectCitationUrls(markdown),
      normalizedLinkCount,
      generatedSourceCount: catalog.length,
      removedSourceSectionHeadings: sections.map((section) => section.heading),
      removedUnknownUrls: [...removals].sort(
        (left, right) => left.offset - right.offset,
      ),
    },
  };
}

/**
 * Citation URLs present in a canonical document, recovered by re-parsing the
 * finished Markdown. Deriving the inventory from the output rather than from
 * rewrite bookkeeping is what lets the audit's `source_removed` and
 * `source_introduced` checks detect a canonicalizer defect.
 */
export function collectCitationUrls(markdown: string): string[] {
  const root = parseMarkdown(markdown);
  const urls: string[] = [];
  visit(root, (node) => {
    if (node.type === "image") {
      // Images are never edited, but their URLs still ship; the inventory
      // must see them so an unvalidated image URL fails the audit closed.
      if (node.url !== undefined && isHttpUrl(node.url)) {
        urls.push(normalizeCitationUrl(node.url));
      }
      return false;
    }
    if (isSkippedContainer(node)) return false;
    if (node.type === "text" && node.value !== undefined) {
      // Raw URLs inside preserved editorial labels ship as plain text;
      // recover them so the audit sees what its legacy raw scan saw.
      for (const raw of extractRawCitationUrls(node.value)) {
        urls.push(normalizeCitationUrl(raw));
      }
      return true;
    }
    if (node.type !== "link" && node.type !== "definition") return true;
    if (node.url === undefined) return true;
    if (!isHttpUrl(node.url)) return true;
    urls.push(normalizeCitationUrl(node.url));
    return true;
  });
  return uniqueSorted(urls);
}

function buildCitationCatalog(graph: ResearchEvidenceGraph): CatalogEntry[] {
  const byUrl = new Map<string, { title: string; sourceIds: string[] }>();
  for (const node of graph.sources) {
    if (node.status !== "usable") continue;
    if (!isHttpUrl(node.canonicalUrl)) continue;
    const url = normalizeCitationUrl(node.canonicalUrl);
    const existing = byUrl.get(url);
    if (!existing) {
      byUrl.set(url, { title: node.title, sourceIds: [node.id] });
      continue;
    }
    if (existing.title !== node.title) {
      throw new Error(
        `Research citation canonicalization found conflicting titles for '${url}': ` +
          `'${existing.title}' and '${node.title}'.`,
      );
    }
    existing.sourceIds.push(node.id);
  }
  return [...byUrl.entries()]
    .map(([url, value]) => ({
      url,
      title: value.title,
      sourceIds: [...value.sourceIds].sort(),
    }))
    // Code-unit order (same as a plain string sort) to match
    // collectCitationUrls' inventory ordering, so nobody ever diffs two
    // differently-ordered "sorted" URL lists.
    .sort((left, right) =>
      left.url < right.url ? -1 : left.url > right.url ? 1 : 0,
    );
}

/**
 * Every source backing a supported claim must be usable and HTTP(S). The audit
 * requires such sources to appear in the publication regardless of status, so a
 * stale or missing one must fail loudly rather than be dropped as unknown.
 */
function assertSupportedClaimsAreUsable(
  graph: ResearchEvidenceGraph,
  catalog: readonly CatalogEntry[],
): void {
  const catalogUrls = new Set(catalog.map((entry) => entry.url));
  const sourceById = new Map(graph.sources.map((node) => [node.id, node]));
  for (const claim of graph.claims) {
    if (claim.status !== "supported") continue;
    for (const sourceId of claim.supportingSourceIds) {
      const node = sourceById.get(sourceId);
      if (!node) {
        throw new Error(
          `Research citation canonicalization cannot resolve source '${sourceId}' ` +
            `supporting claim '${claim.id}'.`,
        );
      }
      if (node.status !== "usable") {
        throw new Error(
          `Research citation canonicalization rejects source '${sourceId}' supporting ` +
            `claim '${claim.id}': status is '${node.status}', not 'usable'.`,
        );
      }
      if (!catalogUrls.has(normalizeCitationUrl(node.canonicalUrl))) {
        throw new Error(
          `Research citation canonicalization rejects source '${sourceId}' supporting ` +
            `claim '${claim.id}': '${node.canonicalUrl}' is not a valid HTTP(S) URL.`,
        );
      }
    }
  }
}

function planFootnote(params: {
  node: MarkdownNode;
  source: string;
  catalogByUrl: ReadonlyMap<string, CatalogEntry>;
  removals: ResearchCitationRemoval[];
  identifier: string;
}): FootnotePlan {
  const { node, source, catalogByUrl, removals, identifier } = params;
  const citations: FootnoteCitation[] = [];
  const seen = new Set<string>();
  const innerEdits: Edit[] = [];
  let hasProse = false;

  visit(node, (child, parents) => {
    if (isSkippedContainer(child)) return false;
    if (child === node) return true;
    if (child.type === "text" && child.value !== undefined) {
      if (
        !parents.some((parent) => parent.type === "link") &&
        PROSE_PATTERN.test(child.value)
      ) {
        hasProse = true;
      }
      return true;
    }
    if (child.type !== "link" || child.url === undefined) return true;
    if (!isHttpUrl(child.url)) return true;

    const url = normalizeCitationUrl(child.url);
    const entry = catalogByUrl.get(url);
    if (entry) {
      if (!seen.has(url)) {
        seen.add(url);
        citations.push({ label: footnoteLabel(child, source), url });
      }
    } else {
      removals.push({
        url,
        kind: "footnote_definition",
        offset: child.start,
      });
    }
    // Citations migrate inline; the definition retains only its prose.
    innerEdits.push(removeInline(source, child.start, child.end));
    return true;
  });

  if (!hasProse) {
    return {
      identifier,
      citations,
      definitionText: undefined,
      definitionStart: node.start,
      definitionEnd: node.end,
    };
  }
  const rebased = innerEdits.map((edit) => ({
    start: edit.start - node.start,
    end: edit.end - node.start,
    text: edit.text,
  }));
  const definitionText = applyEdits(
    source.slice(node.start, node.end),
    rebased,
  ).replace(/\s+$/u, "");
  return {
    identifier,
    citations,
    definitionText,
    definitionStart: node.start,
    definitionEnd: node.end,
  };
}

function footnoteLabel(node: MarkdownNode, source: string): string {
  const label = innerText(node, source).trim();
  if (!label) return DEFAULT_FOOTNOTE_LABEL;
  // Autolinks and bare URLs render their own URL as text; that is not a label.
  if (isHttpUrl(label)) return DEFAULT_FOOTNOTE_LABEL;
  return normalizeLabelEscapes(label);
}

/** Unknown URLs inside a dropped duplicate footnote still count as repairs. */
function recordUnknownUrlsInFootnote(params: {
  node: MarkdownNode;
  catalogByUrl: ReadonlyMap<string, CatalogEntry>;
  removals: ResearchCitationRemoval[];
}): void {
  const { node, catalogByUrl, removals } = params;
  visit(node, (child) => {
    if (isSkippedContainer(child)) return false;
    if (child.type !== "link" || child.url === undefined) return true;
    if (!isHttpUrl(child.url)) return true;
    const url = normalizeCitationUrl(child.url);
    if (!catalogByUrl.has(url)) {
      removals.push({ url, kind: "footnote_definition", offset: child.start });
    }
    return true;
  });
}

function rewriteDefinition(params: {
  node: MarkdownNode;
  source: string;
  catalogByUrl: ReadonlyMap<string, CatalogEntry>;
}): { removed: boolean; url: string; text: string } | undefined {
  const { node, source, catalogByUrl } = params;
  if (node.url === undefined || !isHttpUrl(node.url)) return undefined;
  const url = normalizeCitationUrl(node.url);
  const entry = catalogByUrl.get(url);
  if (!entry) return { removed: true, url, text: "" };
  const raw = source.slice(node.start, node.end);
  const match = DEFINITION_URL_PATTERN.exec(raw);
  if (!match) return undefined;
  const [, prefix, , suffix] = match;
  if (prefix === undefined || suffix === undefined) return undefined;
  const text = `${prefix}${emitLinkDestination(entry.url)}${suffix}`;
  return text === raw ? undefined : { removed: false, url, text };
}

function rewriteLink(params: {
  node: MarkdownNode;
  source: string;
  catalogByUrl: ReadonlyMap<string, CatalogEntry>;
  removals: ResearchCitationRemoval[];
}): { edit: Edit; normalized: boolean } | undefined {
  const { node, source, catalogByUrl, removals } = params;
  if (node.url === undefined || !isHttpUrl(node.url)) return undefined;
  const url = normalizeCitationUrl(node.url);
  const raw = source.slice(node.start, node.end);
  const kind = linkKind(node, source);
  const entry = catalogByUrl.get(url);

  if (!entry) {
    removals.push({ url, kind, offset: node.start });
    if (kind === "inline_link") {
      const preserved = preservedLabelText(innerText(node, source), url);
      if (preserved) {
        return {
          edit: { start: node.start, end: node.end, text: preserved },
          normalized: false,
        };
      }
    }
    return {
      edit: removeInline(source, node.start, node.end),
      normalized: false,
    };
  }

  const text =
    kind === "inline_link"
      ? `[${escapeLabel(normalizeLabelEscapes(innerText(node, source)))}](${emitLinkDestination(entry.url)})`
      : kind === "autolink"
        ? `<${entry.url}>`
        : // A bare URL with parentheses would re-parse as a mangled GFM
          // autolink literal; the angle-bracket form keeps it intact.
          /[()]/u.test(entry.url)
          ? `<${entry.url}>`
          : entry.url;
  if (text === raw) return undefined;
  return {
    edit: { start: node.start, end: node.end, text },
    normalized: true,
  };
}

/**
 * Readable text kept when an unknown inline link is removed. A label that is
 * the removed URL itself (in any normalized spelling) is dropped entirely,
 * and any URL still embedded in the label is scrubbed, so a removed URL can
 * never leak into the publication through its own link label.
 */
function preservedLabelText(label: string, removedUrl: string): string {
  const trimmed = label.trim();
  if (trimmed && isHttpUrl(trimmed) && normalizeCitationUrl(trimmed) === removedUrl) {
    return "";
  }
  return escapeLabel(normalizeLabelEscapes(stripCitationUrls(label)))
    // A stripped URL leaves an empty angle-bracket or paren wrapper
    // behind; drop it so a scrubbed label ships no dangling punctuation.
    .replace(/<\s*>|\(\s*\)/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
}

function linkKind(
  node: MarkdownNode,
  source: string,
): ResearchCitationRemovalKind {
  if (source[node.start] === "<") return "autolink";
  const children = node.children ?? [];
  const first = children[0];
  const last = children[children.length - 1];
  if (first && last && first.start === node.start && last.end === node.end) {
    return "bare_url";
  }
  return "inline_link";
}

interface SourceSection {
  readonly start: number;
  readonly end: number;
  readonly heading: string;
}

function findSourceSections(
  root: MarkdownNode,
  source: string,
): SourceSection[] {
  const children = root.children ?? [];
  const sections: SourceSection[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (!node || node.type !== "heading") continue;
    const raw = source.slice(node.start, node.end);
    const match = HEADING_TEXT_PATTERN.exec(raw);
    const heading = match?.[1]?.trim();
    if (heading === undefined || !isSourceSectionHeading(heading)) continue;
    const depth = headingDepth(raw);
    let end = source.length;
    for (let next = index + 1; next < children.length; next += 1) {
      const candidate = children[next];
      if (!candidate || candidate.type !== "heading") continue;
      if (headingDepth(source.slice(candidate.start, candidate.end)) <= depth) {
        end = candidate.start;
        break;
      }
    }
    sections.push({ start: node.start, end, heading });
  }
  return sections;
}

function headingDepth(raw: string): number {
  const match = /^#{1,6}/u.exec(raw);
  return match ? match[0].length : 1;
}

function appendGeneratedSources(params: {
  body: string;
  catalog: readonly CatalogEntry[];
  relocatedFootnotes: readonly string[];
}): string {
  const parts = [params.body];
  for (const footnote of params.relocatedFootnotes) {
    parts.push(footnote);
  }
  // An empty catalog gets no section: a heading without entries is a
  // confusing artifact, and the audit blocks publication on it anyway.
  if (params.catalog.length > 0) {
    const entries = params.catalog
      .map(
        (entry) =>
          `- [${escapeLabel(entry.title)}](${emitLinkDestination(entry.url)})`,
      )
      .join("\n");
    parts.push(`## Sources\n\n${entries}`);
  }
  return `${parts.filter((part) => part !== "").join("\n\n")}\n`;
}

function parseMarkdown(markdown: string): MarkdownNode {
  const parsed: unknown = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(markdown);
  const root = toMarkdownNode(parsed);
  if (!root) {
    throw new Error("Research citation canonicalization could not parse Markdown.");
  }
  return root;
}

function toMarkdownNode(value: unknown): MarkdownNode | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const position = value.position;
  if (!isRecord(position)) return undefined;
  const start = isRecord(position.start) ? position.start.offset : undefined;
  const end = isRecord(position.end) ? position.end.offset : undefined;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  const children: MarkdownNode[] = [];
  if (Array.isArray(value.children)) {
    for (const child of value.children) {
      const parsed = toMarkdownNode(child);
      if (parsed) children.push(parsed);
    }
  }
  return {
    type: value.type,
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    ...(typeof value.identifier === "string"
      ? { identifier: value.identifier }
      : {}),
    children,
    start,
    end,
  };
}

/** Depth-first visitor; returning false skips a node's children. */
function visit(
  node: MarkdownNode,
  callback: (
    node: MarkdownNode,
    parents: readonly MarkdownNode[],
  ) => boolean,
  parents: readonly MarkdownNode[] = [],
): void {
  if (!callback(node, parents)) return;
  const nextParents = [...parents, node];
  for (const child of node.children ?? []) {
    visit(child, callback, nextParents);
  }
}

/** Content whose URLs are examples, not citations. */
function isSkippedContainer(node: MarkdownNode): boolean {
  return (
    node.type === "code" ||
    node.type === "inlineCode" ||
    node.type === "html" ||
    node.type === "image" ||
    node.type === "imageReference"
  );
}

function innerText(node: MarkdownNode, source: string): string {
  const children = node.children ?? [];
  const first = children[0];
  const last = children[children.length - 1];
  if (!first || !last) return "";
  return source.slice(first.start, last.end);
}

function escapeLabel(value: string): string {
  return value.replace(/([[\]])/gu, "\\$1");
}

/**
 * Removes backslash escapes from label brackets so a re-emitted label is
 * escaped exactly once, whether the source already escaped it or not.
 */
function normalizeLabelEscapes(value: string): string {
  return value.replace(/\\([\[\]])/gu, "$1");
}

/**
 * Emits a link destination that survives re-parsing. Bare destinations end
 * early on parentheses and several other characters, so such URLs take the
 * angle-bracket form; the rare URL containing angle brackets is %-encoded
 * because that form cannot carry them.
 */
function emitLinkDestination(url: string): string {
  if (!/[()<>"'\s\\]/u.test(url)) return url;
  if (/[<>]/u.test(url)) {
    return `<${url.replace(/</gu, "%3C").replace(/>/gu, "%3E")}>`;
  }
  return `<${url}>`;
}

/** Removes an inline span and the punctuation or spacing it leaves behind. */
function removeInline(source: string, start: number, end: number): Edit {
  let from = start;
  let to = end;
  const wraps =
    (source[from - 1] === "(" && source[to] === ")") ||
    (source[from - 1] === "[" && source[to] === "]");
  if (wraps) {
    from -= 1;
    to += 1;
  }
  const before = source[from - 1];
  const after = source[to];
  if (before === " " && (after === undefined || /[\s.,;:!?)\]]/u.test(after))) {
    from -= 1;
  } else if (after === " " && (before === undefined || /[\s([]/u.test(before))) {
    to += 1;
  }
  return { start: from, end: to, text: "" };
}

/** Removes a block node together with the blank line that followed it. */
function deleteBlock(source: string, start: number, end: number): Edit {
  let to = end;
  while (to < source.length && (source[to] === "\n" || source[to] === "\r")) {
    to += 1;
  }
  return { start, end: to, text: "" };
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: Edit[] = [];
  for (const edit of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && edit.start < previous.end) {
      // Overlapping spans mean an outer removal already covers this edit.
      if (edit.end > previous.end) {
        merged[merged.length - 1] = {
          start: previous.start,
          end: edit.end,
          text: previous.text,
        };
      }
      continue;
    }
    merged.push(edit);
  }
  let output = source;
  for (const edit of [...merged].reverse()) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  return output;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
