import Link from 'next/link';

export const metadata = {
  title: 'About Example Site',
  description: 'Who writes Example Site and how we research each guide.',
};

export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p>
        Example Site publishes practical guides for founders raising their first rounds. Every article is written by
        an operator and reviewed by an editor before it goes live. Start with{' '}
        <Link href="/blog/why-vcs-dont-return-calls/">why VCs don&apos;t return calls</Link>.
      </p>
    </main>
  );
}
