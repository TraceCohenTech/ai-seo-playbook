import Link from 'next/link';

export default function Home() {
  return (
    <main>
      <h1>Acme Insights</h1>
      <Link href="/blog/foo-bar-post">Read the latest post</Link>
      <a href="/about">About</a>
    </main>
  );
}
