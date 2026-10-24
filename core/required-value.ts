export function requiredValue<T>(
  value: T | null | undefined,
  label = 'value',
): T {
  if (value === undefined || value === null) {
    throw new Error(`${label} is required`)
  }
  return value
}
