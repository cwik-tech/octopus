const TEXT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "about",
  "after",
  "be",
  "brief",
  "by",
  "can",
  "create",
  "do",
  "for",
  "from",
  "have",
  "help",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "need",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with",
  "workflow",
  "would",
  "you",
]);

export function significantTextTokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 2)
        .filter((token) => !TEXT_STOP_WORDS.has(token)),
    ),
  );
}
