import type { MetadataRoute } from 'next';

/**
 * Serves /sitemap.xml. Only the public, indexable pages — everything
 * else is authenticated or sensitive (see robots.ts's disallow list).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vaultpoint.name.ng';
  const lastModified = new Date();

  return [
    { url: `${baseUrl}/`, lastModified, changeFrequency: 'monthly', priority: 1 },
    { url: `${baseUrl}/login`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${baseUrl}/signup`, lastModified, changeFrequency: 'yearly', priority: 0.8 },
    { url: `${baseUrl}/terms`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/privacy`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/risk-disclosure`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
