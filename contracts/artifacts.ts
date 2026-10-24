export interface ParsedMarkdownArtifact {
  metadata: Record<string, string>
  body: string
  hasFrontmatter: boolean
}
