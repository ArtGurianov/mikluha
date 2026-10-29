import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LegalPageView } from "@/components/site/legal-page-view";
import { getBakedContent, loadSiteContent } from "@/lib/cms/content";
import { isSsr } from "@/lib/site";
import { getLegalPageBySlug } from "@/lib/legal";

/**
 * Top-level route for every legalPage document in the CMS — /oferta/,
 * /privacy-policy/, and anything else the organizer publishes later (согласие,
 * возврат, памятка туристу) without waiting for a code release.
 *
 * It sits at the site root rather than under /legal/ to keep the short URLs
 * these pages already have, which means it nominally claims the whole top-level
 * slug namespace. Two things keep that safe: only a slug of a baked legal page
 * renders (the static export generates exactly those; under SSR any other slug
 * is `notFound()` — everything else is a real 404, not a blank legal page), and
 * the reserved-slug check in scripts/validate-content.ts that stops a document
 * from shadowing /tours/, /reports/ or a build artifact. Under SSR there is no
 * `generateStaticParams`: the page waits for the request so the media switch
 * applies to its layout, and it never reads Commerce.
 */
export const generateStaticParams = isSsr
  ? undefined
  : () => getBakedContent().legalPages.map((page) => ({ legalSlug: page.slug }));

export async function generateMetadata(props: PageProps<"/[legalSlug]">): Promise<Metadata> {
  const { legalSlug } = await props.params;
  const page = getLegalPageBySlug(await loadSiteContent(), legalSlug);
  if (!page) return {};
  return { title: page.title, alternates: { canonical: `/${page.slug}/` } };
}

export default async function LegalPage(props: PageProps<"/[legalSlug]">) {
  const { legalSlug } = await props.params;
  const page = getLegalPageBySlug(await loadSiteContent(), legalSlug);
  if (!page) notFound();
  return <LegalPageView page={page} />;
}
