/**
 * Dynamic Sitemap for Next.js (App Router)
 *
 * Key principles:
 *   1. Every URL in the sitemap must return 200 — never submit redirects or 404s
 *   2. lastmod should be honest — only update when content actually changes
 *   3. Separate your news sitemap (48h rolling) from your main sitemap
 *   4. Don't submit thin/directory pages unless they have real content
 *
 * Place this file at: src/app/sitemap.ts
 */

import type { MetadataRoute } from 'next';

// Your posts data — however you store it
import { getAllPosts } from '@/lib/posts';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = 'https://example.com';
  const posts = await getAllPosts();

  const staticPages: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: 'daily', priority: 1.0 },
    { url: `${baseUrl}/blog`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    // Add all your static routes here
  ];

  const blogPages: MetadataRoute.Sitemap = posts.map(post => ({
    url: `${baseUrl}/blog/${post.slug}`,
    // Use lastUpdated if available, otherwise fall back to publish date
    // This is critical for the refresh drip — when you update a post,
    // the lastmod bump signals freshness to Google
    lastModified: post.lastUpdated
      ? new Date(post.lastUpdated)
      : new Date(post.date),
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  // Server-rendered full index pages — critical for crawlability
  // If your blog index is client-side (load-more button), Google can't
  // discover your posts. These server-rendered pages fix that.
  const indexPages: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/blog/all`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.8,
    },
  ];

  return [...staticPages, ...indexPages, ...blogPages];
}
