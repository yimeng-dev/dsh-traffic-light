import { describe, expect, it } from 'vitest'
import { readDshLocalePreference } from './locale.js'

describe('readDshLocalePreference', () => {
  it.each([
    [{ preference: 'zh' }, 'zh'],
    [{ preference: 'en' }, 'en'],
    [{}, undefined],
    [{ preference: 'fr' }, undefined],
    [null, undefined],
    [[], undefined],
  ] as const)('reads %j as %s', (settings, expected) => {
    expect(readDshLocalePreference(settings)).toBe(expected)
  })
})
