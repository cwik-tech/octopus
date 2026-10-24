import { describe, expect, it } from "vitest";

// Every surface and accent color comes from the tokens in index.css, so a
// palette change there recolors the whole app. A hex value baked into a class
// name skips the tokens and keeps its old color in every theme.
const sources = import.meta.glob<string>(
  ["../**/*.{ts,tsx}", "!../**/__tests__/**", "!../**/*.test.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
);

function findClasses(pattern: RegExp): string[] {
  return Object.entries(sources).flatMap(([file, source]) =>
    [...source.matchAll(pattern)].map(
      (match) => `${file.replace(/^\.\.\//, "")}: ${match[1]}`,
    ),
  );
}

// A finished step's green and a warning's amber mean the same thing in every
// theme, so the journey rail's status markers may keep literal colors.
const STATUS_CLASSES: ReadonlySet<string | undefined> = new Set([
  "dark:border-[#3ecf8e]",
  "dark:bg-[#3ecf8e]",
  "dark:text-[#0b0e14]",
  "dark:border-[#f0b45a]",
  "dark:bg-[#f0b45a]/10",
  "dark:text-[#f0b45a]",
]);

describe("theme colors", () => {
  it("takes class colors from theme tokens, not hex values", () => {
    const hexClasses = findClasses(
      /(?<=^|[\s"'`])((?:[\w-]+:)*[\w-]+-\[#[0-9a-fA-F]{3,8}\](?:\/[\d.]+)?)/g,
    ).filter((found) => !STATUS_CLASSES.has(found.split(": ")[1]));

    expect(hexClasses).toEqual([]);
  });

  it("colors accent text with text-primary-text", () => {
    // In dark mode the accent is a fill: white text on it passes, but the
    // accent itself as text on the dark canvas measures 3.4:1. Text and icons
    // use the lighter --primary-text instead.
    const accentText = findClasses(
      /(?<=^|[\s"'`])((?:[\w-]+:)*text-primary(?:\/[\d.[\]]+)?)(?=[\s"'`]|$)/g,
    );

    expect(accentText).toEqual([]);
  });
});
