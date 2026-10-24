import * as os from "node:os";
import * as path from "node:path";

const FALLBACK_DIRECTORIES = [
  path.join(os.homedir(), ".local", "bin"),
  "/Applications/ChatGPT.app/Contents/Resources",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export function cliPathEntries(currentPath = process.env.PATH): string[] {
  const configuredEntries = currentPath?.split(path.delimiter) ?? [];
  const fallbackEntries =
    process.env.PIPELINE_CLI_PATH_FALLBACK === "0"
      ? []
      : [path.dirname(process.execPath), ...FALLBACK_DIRECTORIES];
  return [...configuredEntries, ...fallbackEntries].filter(
    (value, index, values) => Boolean(value) && values.indexOf(value) === index,
  );
}

export function buildCliPath(currentPath = process.env.PATH): string {
  return cliPathEntries(currentPath).join(path.delimiter);
}
