import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import { RouterProvider } from 'react-router';
import { createRouter } from '@/routes';
import { ThemeProvider, useTheme } from '@/context/ThemeContext';
import { LocaleProvider, useLocale } from '@/context/LocaleContext';
import '@/i18n';
import '@/styles/index.css';

function AntdConfig({ children }: { children: React.ReactNode }) {
  const { accentColor, antdAlgorithm } = useTheme();
  const { antdLocale } = useLocale();
  return (
    <ConfigProvider
      theme={{
        algorithm: antdAlgorithm,
        token: { colorPrimary: accentColor, borderRadius: 6 },
      }}
      componentSize="middle"
      locale={antdLocale}
    >
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <LocaleProvider>
        <AntdConfig>
          <RouterProvider router={createRouter({})} />
        </AntdConfig>
      </LocaleProvider>
    </ThemeProvider>
  </StrictMode>,
);
