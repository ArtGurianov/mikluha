import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LegalPageView } from "@/components/site/legal-page-view";
import { loadSiteContent } from "@/lib/cms/content";
import { getLegalPageBySlug } from "@/lib/legal";

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
