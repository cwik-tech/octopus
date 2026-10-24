import { expect, test } from 'vitest'

import { cn } from '@/lib/utils/utils'

test('cn returns a merged class string for simple inputs', () => {
  expect(cn('foo')).toBe('foo')
})

test('cn merges conflicting Tailwind classes (last wins)', () => {
  // twMerge drops the earlier conflicting class (bg-red) but keeps original
  // order for the survivors, so bg-blue wins while text-white stays put.
  expect(cn('bg-red text-white', 'bg-blue')).toBe('text-white bg-blue')
})

test('cn handles arrays of class values', () => {
  expect(cn(['foo', 'bar'], 'baz')).toBe('foo bar baz')
})

test('cn ignores falsy values', () => {
  expect(cn('foo', null, undefined, false, 0, '', NaN)).toBe('foo')
})

test('cn handles clsx-style conditional objects', () => {
  expect(cn({ active: true, 'text-red': true }, { 'text-blue': false }))
    .toBe('active text-red')
})
