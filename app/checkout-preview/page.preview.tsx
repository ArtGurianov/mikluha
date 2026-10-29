import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Checkout UI preview", robots: { index: false, follow: false },
};

export default async function CheckoutPreviewPage() {
  // Defense in depth: next.config excludes the .preview.tsx route outside development.
  if (process.env.NODE_ENV !== "development") notFound();
  const { CheckoutPreview } = await import("@/components/booking/checkout-preview");
  return <CheckoutPreview />;
}
