/** Build an object fragment unless the exact-optional value is undefined. */
export function whenDefined<T, R extends object>(
  value: T | undefined,
  build: (value: T) => R,
): R | object {
  return value === undefined ? {} : build(value)
}
