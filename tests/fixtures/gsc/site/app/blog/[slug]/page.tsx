export default function Post({ params }: { params: { slug: string } }) {
  return <article><h1>{params.slug}</h1></article>;
}
