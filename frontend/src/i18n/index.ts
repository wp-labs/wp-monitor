import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { enUS } from './resources/en-US';
import { zhCN } from './resources/zh-CN';
import { zhTW } from './resources/zh-TW';
import { normalizeLocale, SUPPORTED_LOCALES, type AppLocale } from './types';

export const LOCALE_STORAGE_KEY = 'wp-monitor-locale';

export function readInitialLocale(): AppLocale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    const storedLocale = normalizeLocale(stored);
    if (storedLocale) return storedLocale;
  } catch {
    // localStorage unavailable
  }

  const browserLocale =
    typeof navigator === 'undefined' ? null : normalizeLocale(navigator.language);
  return browserLocale ?? 'zh-CN';
}

void i18n.use(initReactI18next).init({
  lng: readInitialLocale(),
  fallbackLng: 'zh-CN',
  supportedLngs: [...SUPPORTED_LOCALES],
  resources: {
    'zh-CN': { translation: zhCN },
    'zh-TW': { translation: zhTW },
    'en-US': { translation: enUS },
  },
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
