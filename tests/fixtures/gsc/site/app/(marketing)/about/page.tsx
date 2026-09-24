import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'About Example Capital and the Team' };
const updated = { dateModified: '2026-09-01' };
export default function About() {
  return <article><h1>About us</h1><p>Updated {updated.dateModified}.</p></article>;
}
