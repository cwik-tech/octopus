const quadrantChartDeclarationPattern = /^\s*quadrantChart\s*$/im

// Mermaid parses punctuation in bare quadrant labels as syntax tokens, while quoted labels preserve it as text.
const unquotedQuadrantLabelPattern =
  /^([ \t]*quadrant-[1-4][ \t]+)(?!")([^"\r\n]*?[^"\s])([ \t]*)$/gim

export function normalizeChatMermaidSource(source: string): string {
  if (!quadrantChartDeclarationPattern.test(source)) return source

  return source.replace(
    unquotedQuadrantLabelPattern,
    (_line, prefix: string, label: string, trailingSpace: string) =>
      `${prefix}"${label}"${trailingSpace}`,
  )
}
