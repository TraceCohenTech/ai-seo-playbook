import type { Metadata } from 'next';
import { Calculator } from '@/components/calculator';

// Fixture: openGraph.title appears BEFORE the page title and is long; only the page title
// (50 chars) should be checked. With --title-suffix " | Example Site" it becomes 65 chars.
export const metadata: Metadata = {
  openGraph: {
    title: 'Startup Valuation Calculator: Free Pre-Money and Post-Money Estimates for Founders',
  },
  title: 'Startup Valuation Calculator for Seed-Stage Teams',
  description: "Estimate pre-money and post-money valuation in seconds. It's free and needs no sign-up.",
};

export default function Page() {
  return (
    <main>
      <h1>Startup valuation calculator</h1>
      <p>Enter your round size and the percentage you plan to sell. The calculator shows the implied pre-money and post-money valuation.</p>
      <div id="density-report">
        <Calculator mode="valuation" />
      </div>
      <p>
        Numbers are estimates. Read <a href="/blog/why-vcs-dont-return-calls">why VCs don&apos;t return calls</a> before
        you send the deck.
      </p>
    </main>
  );
}
