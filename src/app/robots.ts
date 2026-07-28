import type { MetadataRoute } from 'next';

/**
 * Serves /robots.txt via Next's special-file convention. Dashboard/API/
 * auth-callback routes are all authenticated or sensitive — nothing a
 * crawler should index — so only the public marketing/legal surface is
 * allowed.
 */
export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vaultpoint.name.ng';

  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/login', '/signup', '/terms', '/privacy', '/risk-disclosure'],
      disallow: ['/dashboard', '/onboarding', '/api', '/auth', '/reset-password', '/offline'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
