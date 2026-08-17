import type { Metadata } from "next";
import { Manrope } from "next/font/google";

import { BookingModal } from "@/components/booking/booking-modal";
import { BookingModalProvider } from "@/components/booking/booking-provider";
import { Footer } from "@/components/site/footer";
import { Header } from "@/components/site/header";
import { getContent } from "@/lib/cms/content";
import { jsonLdScript } from "@/lib/json-ld";
import { getLegalPagesSorted } from "@/lib/legal";
import { deployEnv, isStaging, resolveCanonicalBase } from "@/lib/site";
import { getAllBookableDepartures, getBookingFallback, getTodayInTimezone } from "@/lib/tours";

import "./globals.css";

const manrope = Manrope({
  variable: "--font-sans",
  subsets: ["cyrillic", "latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const { siteSettings, tours } = getContent();
  const canonicalCoverImage = siteSettings.seo.ogImage?.src ?? tours[0]?.coverImage.src;

  return {
    metadataBase: new URL(resolveCanonicalBase(siteSettings.siteUrl)),
    title: { default: siteSettings.seo.title, template: `%s — ${siteSettings.siteName}` },
    description: siteSettings.seo.description,
    alternates: { canonical: "/" },
    robots: isStaging ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: {
      title: siteSettings.seo.title,
      description: siteSettings.seo.description,
      siteName: siteSettings.siteName,
      locale: "ru_RU",
      type: "website",
      images: canonicalCoverImage ? [{ url: canonicalCoverImage }] : undefined,
    },
    other: { "deploy-env": deployEnv },
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  const content = getContent();
  const { siteSettings } = content;
  const legalPages = getLegalPagesSorted(content);
  const today = getTodayInTimezone(siteSettings.timezone);
  const bookableDepartures = getAllBookableDepartures(content, today);
  const bookingFallback = getBookingFallback(content);

  const canonicalBase = resolveCanonicalBase(siteSettings.siteUrl);
  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "TravelAgency",
    name: siteSettings.siteName,
    url: canonicalBase,
    ...(siteSettings.logo ? { logo: new URL(siteSettings.logo.src, canonicalBase).href } : {}),
    telephone: siteSettings.company.phone,
    ...(siteSettings.company.email ? { email: siteSettings.company.email } : {}),
  };

  return (
    <html lang="ru" className={`${manrope.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(organizationJsonLd) }}
        />
        <BookingModalProvider departures={bookableDepartures} fallback={bookingFallback}>
          <Header siteSettings={siteSettings} />
          <main className="flex-1">{children}</main>
          <Footer siteSettings={siteSettings} legalPages={legalPages} />
          <BookingModal />
        </BookingModalProvider>
      </body>
    </html>
  );
}
