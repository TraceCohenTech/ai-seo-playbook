/**
 * Related Posts Component for Next.js
 *
 * Automatically links to related content based on shared tags/categories.
 * Solving the orphan page problem: every post should link to related posts,
 * and every post should receive at least one inbound link.
 *
 * Place this at the bottom of your blog post layout.
 *
 * Usage:
 *   <RelatedPosts currentSlug="spacex-ipo-valuation-2026" tags={["spacex", "ipo", "valuation"]} />
 */

import Link from 'next/link';

interface Post {
  slug: string;
  title: string;
  date: string;
  tags: string[];
  description?: string;
}

interface RelatedPostsProps {
  currentSlug: string;
  tags: string[];
  allPosts: Post[];
  maxPosts?: number;
}

export function RelatedPosts({
  currentSlug,
  tags,
  allPosts,
  maxPosts = 4,
}: RelatedPostsProps) {
  const scored = allPosts
    .filter(post => post.slug !== currentSlug)
    .map(post => {
      const sharedTags = post.tags.filter(t => tags.includes(t));
      return { post, score: sharedTags.length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.post.date).getTime() - new Date(a.post.date).getTime();
    })
    .slice(0, maxPosts);

  if (scored.length === 0) return null;

  return (
    <section aria-label="Related posts">
      <h2>Related</h2>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {scored.map(({ post }) => (
          <li key={post.slug} style={{ marginBottom: '1rem' }}>
            <Link href={`/blog/${post.slug}`}>
              {post.title}
            </Link>
            {post.description && (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', opacity: 0.7 }}>
                {post.description}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * In-content link inserter (server-side utility)
 *
 * Scans post body for mentions of topics you have pages about,
 * and wraps the first occurrence in a link. Run this at build time
 * or in your content pipeline before publishing.
 *
 * Example:
 *   const linkedContent = insertInternalLinks(postBody, linkMap);
 */
interface LinkTarget {
  phrases: string[];
  url: string;
  title: string;
}

export function insertInternalLinks(
  content: string,
  linkTargets: LinkTarget[],
  maxLinksPerPost = 5
): string {
  let result = content;
  let linksInserted = 0;

  for (const target of linkTargets) {
    if (linksInserted >= maxLinksPerPost) break;

    for (const phrase of target.phrases) {
      const regex = new RegExp(`(?<![\\[<])\\b(${escapeRegex(phrase)})\\b(?![\\]>])`, 'i');
      const match = result.match(regex);

      if (match && match.index !== undefined) {
        const link = `[${match[1]}](${target.url})`;
        result = result.slice(0, match.index) + link + result.slice(match.index + match[0].length);
        linksInserted++;
        break;
      }
    }
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
