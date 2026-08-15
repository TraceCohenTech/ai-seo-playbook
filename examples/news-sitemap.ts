/**
 * News Sitemap for Next.js (App Router)
 *
 * A separate sitemap submitted to GSC that only contains articles
 * from the last 48 hours. Google News and Discover use this to
 * find fresh content quickly.
 *
 * Place this file at: src/app/news-sitemap.xml/route.ts
 *
 * Then submit https://example.com/news-sitemap.xml in GSC as a
 * separate sitemap from your main sitemap.
 */

import { getRecentStories } from '@/lib/news';

export async function GET() {
  const stories = await getRecentStories();
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48 hours

  const recentStories = stories.filter(
    s => new Date(s.publishedAt).getTime() > cutoff
  );

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${recentStories
  .map(
    story => `  <url>
    <loc>https://example.com/news/${story.slug}</loc>
    <news:news>
      <news:publication>
        <news:name>Your Site Name</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${new Date(story.publishedAt).toISOString()}</news:publication_date>
      <news:title>${escapeXml(story.title)}</news:title>
      ${story.keywords ? `<news:keywords>${escapeXml(story.keywords.join(', '))}</news:keywords>` : ''}
    </news:news>
  </url>`
  )
  .join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
