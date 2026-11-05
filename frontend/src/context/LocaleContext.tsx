import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/zh-tw';
import i18n, { LOCALE_STORAGE_KEY, readInitialLocale } from '@/i18n';
import { LOCALE_META } from '@/i18n/localeMeta';
import type { AppLocale } from '@/i18n/types';

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  antdLocale: (typeof LOCALE_META)[AppLocale]['antdLocale'];
  dayjsLocale: string;
  intlLocale: string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readInitialLocale);
  const meta = LOCALE_META[locale];

  useEffect(() => {
    dayjs.locale(meta.dayjsLocale);
    document.documentElement.lang = meta.htmlLang;
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [locale, meta.dayjsLocale, meta.htmlLang]);

  const setLocale = useCallback((next: AppLocale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      antdLocale: meta.antdLocale,
      dayjsLocale: meta.dayjsLocale,
      intlLocale: meta.intlLocale,
    }),
    [locale, meta.antdLocale, meta.dayjsLocale, meta.intlLocale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}
