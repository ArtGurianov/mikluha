import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LegalPageView } from "@/components/site/legal-page-view";
import { loadLegalPages } from "@/lib/cms/content";
import { REQUIRED_LEGAL_SLUGS, RESERVED_SLUGS, SLUG_RE } from "@/lib/legal";

async function resolvePage(slug: string) {
  if (!SLUG_RE.test(slug) || slug === "admin" || (RESERVED_SLUGS as readonly string[]).includes(slug)) notFound();
  const pages = await loadLegalPages();
  const page = pages?.find((p) => p.slug === slug);
  if (pages !== null && !page && !(REQUIRED_LEGAL_SLUGS as readonly string[]).includes(slug)) notFound();
  return page;
}

export async function generateMetadata(props: PageProps<"/[legalSlug]">): Promise<Metadata> {
  const { legalSlug } = await props.params;
  const page = await resolvePage(legalSlug);
  if (!page) return { title: "Документ временно недоступен", robots: { index: false, follow: false } };
  return { title: page.title, alternates: { canonical: `/${page.slug}/` } };
}

export default async function LegalPage(props: PageProps<"/[legalSlug]">) {
  const { legalSlug } = await props.params;
  const page = await resolvePage(legalSlug);
  if (!page) return (
    <section className="mx-auto max-w-3xl px-4 py-14 sm:px-6" aria-labelledby="legal-unavailable">
      <h1 id="legal-unavailable" className="font-heading text-3xl font-semibold">Документ временно недоступен</h1>
      <p className="mt-4 text-muted-foreground">Сейчас не удалось получить действующую редакцию документа. Попробуйте открыть страницу позже.</p>
      <a className="mt-6 inline-block underline underline-offset-4" href={`/${legalSlug}/`}>Попробовать снова</a>
    </section>
  );
  return <LegalPageView page={page} />;
}
