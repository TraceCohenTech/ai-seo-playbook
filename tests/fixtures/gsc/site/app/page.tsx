import Link from 'next/link';
export const metadata = { title: 'Example Capital: Venture Research', dateModified: '2026-09-15' };
export default function Home() {
  return <main><h1>Example Capital</h1><Link href="/about">About</Link></main>;
}
