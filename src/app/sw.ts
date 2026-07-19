/// <reference lib="webworker" />
// This file runs in the service worker's own global scope, not the DOM —
// tsconfig.json's project-wide `lib` is dom-only (no "webworker", which
// would conflict with "dom" if set globally), so this pulls in
// ServiceWorkerGlobalScope and friends for just this one file instead.
import { ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist, StaleWhileRevalidate } from 'serwist';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';

// Deliberately NOT importing defaultCache from '@serwist/next/worker' — it
// uses NetworkFirst (with a cache fallback) for /api/* and for page
// documents generally, including anything under /dashboard. For a finance
// app that's not acceptable: a cached response for /api/portfolio or a
// /dashboard page could show stale balances/positions/signals as if they
// were current. Every rule below is written explicitly instead.
//
// __SW_MANIFEST is the build-injected precache list's magic global —
// @serwist/next's InjectManifest webpack plugin replaces this identifier
// with the real array at build time. It isn't part of SerwistGlobalConfig
// (that only covers __WB_DISABLE_DEV_LOGS), so it's declared explicitly.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  // self.__SW_MANIFEST is the build-asset precache list @serwist/next
  // injects at build time (see next.config.js's additionalPrecacheEntries,
  // which also adds /offline here) — nothing else is precached.
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    cleanupOutdatedCaches: true,
  },
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Nothing under /api/ is ever cached. Every response could be
    // account-specific and time-sensitive (positions, balances, signals,
    // billing) — always go to the network, no cache read, no cache
    // fallback.
    {
      matcher: ({ url }) => url.pathname.startsWith('/api/'),
      handler: new NetworkOnly(),
    },
    // No authenticated document is ever cached, for the same reason.
    // (dashboard) is a route GROUP in src/app — it doesn't appear in the
    // URL, the real path is /dashboard/*.
    {
      matcher: ({ url }) => url.pathname.startsWith('/dashboard'),
      handler: new NetworkOnly(),
    },
    // Everything else that's a real page load (/, /login, /signup, and
    // any other public/marketing document) — try the network first so
    // content stays current while online, fall back to the precached
    // /offline page when it isn't. This rule runs AFTER the two above,
    // so /api and /dashboard requests never reach it.
    {
      matcher: ({ request }) => request.destination === 'document',
      handler: new NetworkFirst({
        cacheName: 'pages',
        networkTimeoutSeconds: 10,
        plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 })],
      }),
    },
    // Build assets, fonts, and icons aren't account-specific and change
    // infrequently — serve the cached copy immediately, refresh it in the
    // background.
    {
      matcher: ({ url }) => url.pathname.startsWith('/_next/static/'),
      handler: new StaleWhileRevalidate({
        cacheName: 'next-static',
        plugins: [new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 7 * 24 * 60 * 60 })],
      }),
    },
    {
      matcher: ({ request }) => request.destination === 'font',
      handler: new StaleWhileRevalidate({
        cacheName: 'fonts',
        plugins: [new ExpirationPlugin({ maxEntries: 16, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },
    {
      matcher: ({ url }) => url.pathname.startsWith('/icons/') || url.pathname === '/favicon.ico',
      handler: new StaleWhileRevalidate({
        cacheName: 'icons',
        plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },
  ],
  // Applied automatically to every Strategy-based handler above (see
  // Serwist's own constructor) but only ever fires for document requests
  // (the matcher gates on that) — so a failed /api or /dashboard
  // NetworkOnly request never gets silently swapped for a document, while
  // a failed page load (including an unreachable /dashboard, e.g. no
  // network at all) shows the precached /offline page instead of a raw
  // browser connection-error screen. /offline itself never shows cached
  // financial data — it's a static, generic "you're offline" message.
  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher: ({ request }) => request.destination === 'document',
      },
    ],
  },
});

serwist.addEventListeners();
