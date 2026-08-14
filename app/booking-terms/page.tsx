import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LegalPageView } from "@/components/site/legal-page-view";
import { getContent } from "@/lib/cms/content";

export function generateMetadata(): Metadata {
  const page = getContent().legalPages.find((p) => p.slug === "booking-terms");
  if (!page) return {};
  return { title: page.title, alternates: { canonical: "/booking-terms/" } };
}

export default function BookingTermsPage() {
  const page = getContent().legalPages.find((p) => p.slug === "booking-terms");
  if (!page) notFound();
  return <LegalPageView page={page} />;
}
