import { Button, Dropdown } from 'antd';
import { Check, Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/context/LocaleContext';
import { LOCALE_META } from '@/i18n/localeMeta';
import { SUPPORTED_LOCALES, type AppLocale } from '@/i18n/types';

export default function LanguageSwitcher() {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        selectedKeys: [locale],
        items: SUPPORTED_LOCALES.map((item) => ({
          key: item,
          label: (
            <span className="theme-menu-item">
              <span>{LOCALE_META[item].label}</span>
              {locale === item && <Check size={14} className="theme-menu-check" />}
            </span>
          ),
        })),
        onClick: ({ key }) => setLocale(key as AppLocale),
      }}
    >
      <Button
        type="text"
        className="theme-trigger-btn"
        icon={<Languages size={18} />}
        title={t('language.switchTitle')}
      />
    </Dropdown>
  );
}
