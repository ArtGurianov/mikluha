import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Gallery } from "@/components/gallery/gallery";
import { ReportCard } from "@/components/home/report-card";
import { ReviewsSection } from "@/components/home/reviews-section";
import { CmsImage } from "@/components/media/cms-image";
import { MarkdownContent } from "@/components/site/markdown-content";
import { DepartureBookingCard } from "@/components/tours/departure-booking-card";
import { MobileBookingDock } from "@/components/tours/mobile-booking-dock";
import { getContent } from "@/lib/cms/content";
import { jsonLdScript } from "@/lib/json-ld";
import {
  getListedTours,
  getNextDeparture,
  getReportsForTour,
  getReviewsForTour,
  getTodayInTimezone,
  getTourBySlug,
} from "@/lib/tours";

export function generateStaticParams() {
  const content = getContent();
  return getListedTours(content).map((tour) => ({ slug: tour.slug }));
}

export async function generateMetadata(props: PageProps<"/tours/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const content = getContent();
  const tour = getTourBySlug(content, slug);
  if (!tour) return {};

  const title = tour.seo?.title ?? tour.title;
  const description = tour.seo?.description ?? tour.shortDescription;
  const image = tour.seo?.image?.src ?? tour.coverImage.src;

  return {
    title,
    description,
    alternates: { canonical: `/tours/${tour.slug}/` },
    openGraph: { title, description, images: [{ url: image }] },
  };
}

export default async function TourPage(props: PageProps<"/tours/[slug]">) {
  const { slug } = await props.params;
  const content = getContent();
  const tour = getTourBySlug(content, slug);
  if (!tour) notFound();

  const today = getTodayInTimezone(content.siteSettings.timezone);
  const nextDeparture = getNextDeparture(content, tour.id, today);
  const reports = getReportsForTour(content, tour.id);
  const reviews = getReviewsForTour(content, tour.id);

  const eventJsonLd = nextDeparture
    ? {
        "@context": "https://schema.org",
        "@type": "Event",
        name: tour.title,
        startDate: nextDeparture.startDate,
        endDate: nextDeparture.endDate,
        eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        eventStatus:
          nextDeparture.bookingStatus === "CANCELLED"
            ? "https://schema.org/EventCancelled"
            : "https://schema.org/EventScheduled",
        image: [tour.coverImage.src],
        description: tour.shortDescription,
      }
    : null;

  return (
    <article>
      {eventJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(eventJsonLd) }}
        />
      )}

      <div className="relative flex h-[55vh] min-h-96 items-end text-white">
        <CmsImage
          image={tour.coverImage}
          loading="eager"
          fetchPriority="high"
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
        <h1 className="font-heading relative z-10 mx-auto w-full max-w-6xl px-4 pb-10 text-4xl font-semibold sm:px-6 sm:text-5xl">
          {tour.title}
        </h1>
      </div>

      <div className="mx-auto grid max-w-6xl lg:mb-12 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10 lg:px-6">
        <div className="min-w-0">
          <div className="space-y-8 px-4 py-12 sm:px-6 lg:px-0">
            {tour.description && <MarkdownContent value={tour.description} />}

            {tour.gallery.length > 0 && (
              <div className="space-y-3">
                <h2 className="font-heading text-xl font-semibold text-foreground">Фотографии</h2>
                <Gallery images={tour.gallery} />
              </div>
            )}
          </div>

          {reports.length > 0 && (
            <section className="border-t border-border">
              <div className="px-4 py-14 sm:px-6 lg:px-0">
                <h2 className="font-heading mb-6 text-2xl font-semibold text-foreground">
                  Отчёты об этом направлении
                </h2>
                <div className="scrollbar-none flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2">
                  {reports.map((report) => (
                    <ReportCard key={report.id} report={report} tourTitle={tour.title} />
                  ))}
                </div>
              </div>
            </section>
          )}

          <div className="border-t border-border">
            <ReviewsSection reviews={reviews} className="lg:px-0" />
          </div>
        </div>

        <DepartureBookingCard
          departure={nextDeparture}
          className="hidden self-start lg:sticky lg:top-24 lg:mt-12 lg:block"
        />
      </div>

      <MobileBookingDock>
        <DepartureBookingCard departure={nextDeparture} compact />
      </MobileBookingDock>
    </article>
  );
}
