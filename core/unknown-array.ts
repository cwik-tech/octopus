/**
 * `Array.isArray` narrowed to `unknown` elements.
 *
 * The built-in narrows an `unknown` value to `any[]`, which lets unchecked
 * elements flow into typed code; this keeps each element `unknown` until it is
 * checked.
 */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}
