/** Display-only; the original conversation remains available to the Architect. */
export function withoutProposedDiagrams(markdown: string): string {
  const visible: string[] = [];
  let block: { fence: string; hidden: boolean } | undefined;
  for (const line of markdown.split("\n")) {
    if (block) {
      const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/)?.[1];
      if (!block.hidden) visible.push(line);
      if (closing !== undefined && closing[0] === block.fence[0] && closing.length >= block.fence.length) block = undefined;
      continue;
    }
    const opening = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
    const fence = opening?.[1];
    if (fence) block = { fence, hidden: /^mermaid(?:\s|$)/i.test(opening?.[2] ?? "") };
    if (!block?.hidden) visible.push(line);
  }
  return visible.join("\n");
}
