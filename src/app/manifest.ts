import type { MetadataRoute } from 'next';

/**
 * Serves /manifest.webmanifest — Next.js App Router's special-file
 * convention (same pattern as sitemap.ts/robots.ts), auto-linked into
 * every page's <head> with no manual <link rel="manifest"> needed.
 *
 * background_color/theme_color are read from tailwind.config.ts's actual
 * brand tokens (colors.background, colors.accent.DEFAULT), not guessed —
 * keeping them in sync with the app's real dark theme rather than an
 * independently-chosen PWA color that would look wrong on the splash
 * screen.
 *
 * description is deliberately claims-safe: no "grow your wealth" or
 * advice-adjacent language, matching the same caution already applied
 * elsewhere in this codebase (e.g. profit-share.ts explicitly refuses to
 * give investment advice).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'VaultPoint',
    short_name: 'VaultPoint',
    description: 'Track your portfolio, savings goals, and market alerts in one place',
    start_url: '/',
    scope: '/',
    id: '/',
    display: 'standalone',
    orientation: 'portrait',
    categories: ['finance'],
    background_color: '#0A0C10',
    theme_color: '#6C63FF',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
