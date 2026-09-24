import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { absolute: 'Pricing a seed round' },
  description: 'Short notes on pricing a seed round.',
  other: { datePublished: '2023-11-02' },
};

export default function Page() {
  return (
    <main>
      <h1>Pricing a seed round</h1>
      <p>
        This page is a stub. We plan to cover how Example Capital thinks about seed pricing, dilution and
        option pools. Check back soon for the full guide.
      </p>
    </main>
  );
}
