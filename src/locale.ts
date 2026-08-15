export type DshLocale = 'zh' | 'en'

/**
 * Read the explicit preference owned by DSH's official locale plugin.
 * An absent preference deliberately stays undefined: the browser then uses
 * the same navigator-language fallback as DSH itself.
 */
export function readDshLocalePreference(value: unknown): DshLocale | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const preference = (value as Record<string, unknown>).preference
  return preference === 'zh' || preference === 'en' ? preference : undefined
}
