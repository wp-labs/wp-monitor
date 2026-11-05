import { Button, Dropdown } from 'antd';
import { Palette, Sun, Moon, Star, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme, type Theme } from '@/context/ThemeContext';

interface ThemeOption {
  value: Theme;
  label: string;
  icon: typeof Sun;
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'dark-modern',  label: 'Dark Modern',  icon: Moon },
  { value: 'night-blue',   label: 'Night Blue',   icon: Star },
  { value: 'light-modern', label: 'Light Modern',  icon: Sun },
];

export default function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        selectedKeys: [theme],
        items: THEME_OPTIONS.map((t) => ({
          key: t.value,
          icon: <t.icon size={16} />,
          label: (
            <span className="theme-menu-item">
              <span>{t.label}</span>
              {theme === t.value && <Check size={14} className="theme-menu-check" />}
            </span>
          ),
        })),
        onClick: ({ key }) => setTheme(key as Theme),
      }}
    >
      <Button
        type="text"
        className="theme-trigger-btn"
        icon={<Palette size={18} />}
        title={t('theme.switchTitle')}
      />
    </Dropdown>
  );
}
