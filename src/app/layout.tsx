import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SiteFooter } from '@/components/layout/site-footer';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://vaultpoint.name.ng'),
  title: 'VaultPoint — Unified Portfolio & Savings',
  description:
    'Track your crypto, forex, and savings goals in one place. Built for traders, by traders.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'VaultPoint',
  },
  openGraph: {
    title: 'VaultPoint — Unified Portfolio & Savings',
    description:
      'Track your crypto, forex, and savings goals in one place. Built for traders, by traders.',
    url: 'https://vaultpoint.name.ng',
    siteName: 'VaultPoint',
    images: [{ url: '/og-image.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'VaultPoint — Unified Portfolio & Savings',
    description:
      'Track your crypto, forex, and savings goals in one place. Built for traders, by traders.',
    images: ['/og-image.png'],
  },
};

// themeColor/colorScheme live in a separate `viewport` export as of
// Next.js 14 — `metadata.themeColor` is deprecated and logs a build
// warning if used. Value matches tailwind.config.ts's colors.accent
// (#6C63FF), same as app/manifest.ts's theme_color.
export const viewport: Viewport = {
  themeColor: '#6C63FF',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen flex-col">
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
