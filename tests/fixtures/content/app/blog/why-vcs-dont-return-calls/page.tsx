import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArticleHeader,
  Callout,
} from '@/components/article';

// Fixture: a realistic Next.js App Router post. The old regexes stripped `\{[^}]*\}`
// before removing the `export default function` line, wiping the whole JSX body.

export const metadata: Metadata = {
  title: "Why VCs Don't Return Calls: What Founders Get Wrong About Outreach",
  description: 'A practical look at why investors go quiet, and what founders can change in their first email.',
  openGraph: {
    title: 'Why VCs go quiet',
    type: 'article',
    publishedTime: '2025-01-15T09:00:00Z',
  },
  twitter: { title: 'Why VCs go quiet (short)' },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Article', headline: "Why VCs Don't Return Calls", datePublished: '2025-01-15' },
    { '@type': 'BreadcrumbList', itemListElement: [] },
  ],
};

export default function Page(): JSX.Element {
  const related: Array<string> = ['pricing'];
  return (
    <article className="prose mx-auto">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <ArticleHeader title="Why VCs Don't Return Calls" date="2025-01-15" />
      <h1>Why VCs Don&apos;t Return Calls</h1>
      <p>
        Most founders assume silence means no. In practice, a partner at Example Capital told us that roughly 40% of
        the emails she ignores are simply buried under the 300 or so pitches that reach her inbox every week. The
        message was fine; the timing and the ask were not.
      </p>
      <p>
        The first problem is length. A cold email that runs past 200 words forces the reader to decide whether to
        invest ten minutes before she knows whether the company fits her thesis. Short notes that lead with traction
        and a single clear request get read, forwarded, and answered far more often than long ones.
      </p>
      <p>
        The second problem is fit. Acme Robotics sent the same deck to 120 funds in March 2025 and heard back from
        nine. When the team narrowed the list to firms that had led a seed round in warehouse automation during the
        previous two years, the response rate climbed to roughly one in four.
      </p>
      <Callout type="tip">
        Mention one portfolio company the investor backed and explain, in one sentence, why your startup is the
        natural next step in that thesis. It shows you did the homework.
      </Callout>
      <p>
        The third problem is the ask itself. {'"Would love to connect"'} is not a request anyone can act on. A specific
        ask, such as a twenty minute call next Tuesday or feedback on a pricing model, gives the reader something
        concrete to say yes to, and it respects her calendar.
      </p>
      <p>
        Follow-ups matter more than most founders expect. Acme raised $6.6 billion in commitments across its
        customer pipeline pitch only after the third follow-up, which arrived with a new logo and a short update.
        Each follow-up should carry news: a signed pilot, a key hire, a product launch, or a revenue milestone.
      </p>
      <p>
        Warm introductions still beat cold outreach, but only when the introducer knows the company well. A forwarded
        email from someone who met the founder once carries little weight. Ask introducers to add two lines about why
        they believe in the team, and make that easy by drafting a blurb they can edit.
      </p>
      <p>
        Finally, treat every pass as data. Keep a simple log of who replied, how quickly, and what objections came up.
        Patterns appear quickly: if five funds cite market size, the deck needs a clearer bottom-up estimate rather
        than a bigger top-down number borrowed from an analyst report.
      </p>
      <p>
        None of this guarantees a meeting, but it moves the odds in your favour. Investors want to find great
        companies; the founders who make that search easy for them are the ones whose calls get returned. Read our{' '}
        <Link href="/blog/pricing">pricing guide</Link> or the <a href="https://example.com/tools/pricing">pricing
        calculator</a>, and compare notes with <a href="https://www.acme-partners.test/research">Acme Partners</a>.
      </p>
      <ul>
        {related.map((slug) => (
          <li key={slug}>
            <Link href={`/blog/${slug}`}>{slug}</Link>
          </li>
        ))}
      </ul>
    </article>
  );
}
