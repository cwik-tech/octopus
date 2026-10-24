export function heardDialoguePrefix(text: string, heardChars: number): string {
  const boundary = Math.max(0, Math.min(text.length, heardChars))
  const prefix = text.slice(0, boundary)
  if (boundary === text.length || /\s/u.test(text.slice(boundary, boundary + 1))) return prefix.trimEnd()
  return prefix.replace(/\S+$/u, '').trimEnd()
}
