import { getPost } from '@/lib/posts';
import { buildArticleSchema } from '@/lib/schema';

export default async function Post({ params }: { params: { slug: string } }) {
  const post = await getPost(params.slug);
  return (
    <article>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(buildArticleSchema(post)) }}
      />
      <h1>{post.title}</h1>
      <a href={`/blog/${post.related}`}>Related</a>
    </article>
  );
}
