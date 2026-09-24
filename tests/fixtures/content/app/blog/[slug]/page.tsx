import type { Metadata } from 'next';
import { getPost } from '@/lib/posts';

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const post = await getPost(params.slug);
  return {
    title: `${post.title} | Example Site`,
    description: post.summary,
  };
}

export default async function Post({ params }: { params: { slug: string } }) {
  const post = await getPost(params.slug);
  return (
    <article>
      <h1>{post.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: post.html }} />
    </article>
  );
}
