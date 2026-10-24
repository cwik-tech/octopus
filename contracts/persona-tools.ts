/** The tool-list subset of persona frontmatter, shared by generation and editing. */
function splitFrontmatter(markdown: string) {
  const match = /^---[ \t]*(\r?\n)([\s\S]*?)^---[ \t]*(?=\r?\n|$)/m.exec(markdown);
  if (!match || match.index !== 0) return undefined;
  const newline = match[1] ?? "\n";
  const lines = (match[2] ?? "").split(newline);
  if (lines.at(-1) === "") lines.pop();
  return { lines, newline, suffix: markdown.slice(match[0].length) };
}

function withoutComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && quote === '"') { index += 1; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(?:".*"|'.*')$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function toolDeclarations(lines: readonly string[]) {
  const declarations: { start: number; end: number; tools: string[] }[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    const match = /^tools[ \t]*:[ \t]*(.*)$/.exec(lines[start] ?? "");
    if (!match) continue;
    let end = start + 1;
    while (end < lines.length && /^(?:[ \t]+|-(?:[ \t]|$)|[ \t]*(?:#.*)?$)/.test(lines[end] ?? "")) end += 1;
    const scalar = withoutComment(match[1] ?? "");
    const values = scalar === ""
      ? lines.slice(start + 1, end).flatMap((line) => {
          const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
          return item ? [withoutComment(item[1] ?? "")] : [];
        })
      : (scalar.startsWith("[") && scalar.endsWith("]")
          ? scalar.slice(1, -1)
          : unquote(scalar)).split(",");
    declarations.push({ start, end, tools: values.map(unquote).filter((tool) => tool && tool.toLowerCase() !== "none") });
    start = end - 1;
  }
  return declarations;
}

export function readPersonaToolNames(markdown: string | null): string[] {
  const frontmatter = markdown === null ? undefined : splitFrontmatter(markdown);
  return frontmatter ? toolDeclarations(frontmatter.lines).at(-1)?.tools ?? [] : [];
}

/** Normalize only tools to the scalar form the persona runtime reads. */
export function writePersonaToolNames(markdown: string, tools: readonly string[]): string {
  const declaration = `tools: ${[...new Set(tools)].join(", ") || "none"}`;
  const frontmatter = splitFrontmatter(markdown);
  if (!frontmatter) {
    const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
    return ["---", declaration, "---", "", markdown].join(newline);
  }
  const { lines, newline, suffix } = frontmatter;
  const fields = toolDeclarations(lines);
  const output: string[] = [];
  let offset = 0;
  for (const field of fields) {
    output.push(...lines.slice(offset, field.start));
    if (field === fields[0]) output.push(declaration);
    // Comments and blank lines belong to the document, even when between tools.
    output.push(...lines.slice(field.start + 1, field.end).filter((line) => /^[ \t]*(?:#.*)?$/.test(line)));
    offset = field.end;
  }
  output.push(...lines.slice(offset));
  if (fields.length === 0) output.push(declaration);
  return ["---", ...output, "---"].join(newline) + suffix;
}
