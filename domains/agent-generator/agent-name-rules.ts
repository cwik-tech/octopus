/**
 * The repository's Agent naming rule, with nothing else attached.
 *
 * The rule is pure, but the module that owns name reservations is not: it
 * reads and writes receipts. Policy code that only needs to know whether a
 * name is well formed can depend on this file without pulling the filesystem
 * in behind it.
 */

export const MAX_AGENT_NAME_LENGTH = 40;

export function validateExactAgentName(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_AGENT_NAME_LENGTH ||
    !/^[a-z0-9][a-z0-9-]*$/.test(value)
  ) {
    throw new Error(
      `Planned Agent name must be a kebab-case identifier of at most ${MAX_AGENT_NAME_LENGTH} characters: ${value}`,
    );
  }
  return value;
}
