import type { Metadata } from 'next';
import { Chart } from '@/components/chart';

export const metadata: Metadata = {
  title: "Example Capital Fund III: Size, LPs and Strategy",
  description: 'What we know about Example Capital Fund III.',
};

const jsonLd = { '@context': 'https://schema.org', '@type': 'Article', headline: 'Example Capital Fund III', datePublished: '2026-03-02', dateModified: '2026-05-01' };

export default function Page() {
  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1>Example Capital Fund III</h1>
      <p>Example Capital closed its third fund. {"Details below."}</p>
      <Chart data={[1, 2, 3]} />
    </article>
  );
}
