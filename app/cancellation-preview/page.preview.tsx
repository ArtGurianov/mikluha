import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Cancellation/refund UI preview", robots: { index: false, follow: false },
};

export default async function CancellationPreviewPage() {
  // Defense in depth: next.config excludes the .preview.tsx route outside development.
  if (process.env.NODE_ENV !== "development") notFound();
  const { CancellationPreview } = await import("@/components/booking/cancellation-preview");
  return <CancellationPreview />;
}
