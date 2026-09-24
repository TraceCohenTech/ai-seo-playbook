import Image from 'next/image';
import Link from 'next/link';
import { Callout } from '@/components/Callout';

// @graph JSON-LD built from a literal, the pattern Next.js recommends.
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Article',
      headline: 'How Acme Ships Faster With Fewer Meetings',
      datePublished: '2026-08-01',
      dateModified: '2026-09-01',
      image: 'https://example.com/og/foo-bar-post.png',
      author: [
        { '@type': 'Person', name: 'Jane Example', url: 'https://example.com/authors/jane' },
        { '@type': 'Person', name: 'Sam Example' },
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'What does Acme build?',
          acceptedAnswer: { '@type': 'Answer', text: 'Acme builds fictional widgets for demos.' },
        },
        { '@type': 'Question', name: 'Is Acme real?' }, // missing acceptedAnswer
      ],
    },
  ],
};

export default function Page() {
  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1>How Acme Ships Faster</h1>
      <Image src="/img/hero.png" alt="" width={800} height={400} />
      <Callout>Short answer: fewer meetings.</Callout>
      <p>
        See <Link href="/blog/other-post">the other post</Link>, our{' '}
        <a href="/old-post">old post</a>, a <a href="/gone#section">removed page</a> and{' '}
        <a href="FIXTURE_ORIGIN/head-blocked">a HEAD-hostile host</a>.
      </p>
    </article>
  );
}
