import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LegalPageView } from "@/components/site/legal-page-view";
import { getContent } from "@/lib/cms/content";

export function generateMetadata(): Metadata {
  const page = getContent().legalPages.find((p) => p.slug === "privacy-policy");
  if (!page) return {};
  return { title: page.title, alternates: { canonical: "/privacy-policy/" } };
}

export default function PrivacyPolicyPage() {
  const page = getContent().legalPages.find((p) => p.slug === "privacy-policy");
  if (!page) notFound();
  return <LegalPageView page={page} />;
}
