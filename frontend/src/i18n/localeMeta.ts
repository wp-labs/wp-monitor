import type { Locale as AntdLocale } from 'antd/es/locale';
import antdEnUS from 'antd/es/locale/en_US';
import antdZhCN from 'antd/es/locale/zh_CN';
import antdZhTW from 'antd/es/locale/zh_TW';
import type { AppLocale } from './types';

export interface LocaleMeta {
  label: string;
  antdLocale: AntdLocale;
  dayjsLocale: string;
  htmlLang: string;
  intlLocale: string;
}

export const LOCALE_META: Record<AppLocale, LocaleMeta> = {
  'zh-CN': {
    label: '简体中文',
    antdLocale: antdZhCN,
    dayjsLocale: 'zh-cn',
    htmlLang: 'zh-CN',
    intlLocale: 'zh-CN',
  },
  'zh-TW': {
    label: '繁體中文',
    antdLocale: antdZhTW,
    dayjsLocale: 'zh-tw',
    htmlLang: 'zh-TW',
    intlLocale: 'zh-TW',
  },
  'en-US': {
    label: 'English',
    antdLocale: antdEnUS,
    dayjsLocale: 'en',
    htmlLang: 'en',
    intlLocale: 'en-US',
  },
};
