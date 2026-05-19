export const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'en-US'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return SUPPORTED_LOCALES.some((locale) => locale === value);
}

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (!value) return null;
  const normalized = value.replace('_', '-').toLowerCase();

  if (normalized === 'zh-cn' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) {
    return 'zh-CN';
  }
  if (
    normalized === 'zh-tw' ||
    normalized === 'zh-hk' ||
    normalized === 'zh-mo' ||
    normalized === 'zh-hant' ||
    normalized.startsWith('zh-hant-')
  ) {
    return 'zh-TW';
  }
  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en-US';
  }
  return isAppLocale(value) ? value : null;
}
