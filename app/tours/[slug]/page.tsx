import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";

import { BookingButton } from "@/components/booking/booking-button";
import { Gallery } from "@/components/gallery/gallery";
import { ReportCard } from "@/components/home/report-card";
import { ReviewsSection } from "@/components/home/reviews-section";
import { DepartureStatusBadge } from "@/components/site/departure-status-badge";
import { MarkdownContent } from "@/components/site/markdown-content";
import { getContent } from "@/lib/cms/content";
import { formatRub } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import {
  formatDepartureDateRange,
  formatDurationLabel,
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
  const image = tour.seo?.image?.variants.hero ?? tour.coverImage.variants.hero;

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
        image: [tour.coverImage.variants.hero],
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
        <Image src={tour.coverImage.variants.hero} alt={tour.coverImage.alt} fill priority sizes="100vw" className="object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
        <h1 className="font-heading relative z-10 mx-auto w-full max-w-6xl px-4 pb-10 text-4xl font-semibold sm:px-6 sm:text-5xl">
          {tour.title}
        </h1>
      </div>

      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-8">
          {tour.description && <MarkdownContent value={tour.description} />}

          {tour.gallery.length > 0 && (
            <div className="space-y-3">
              <h2 className="font-heading text-xl font-semibold text-foreground">Фотографии</h2>
              <Gallery images={tour.gallery} />
            </div>
          )}
        </div>

        <aside className="h-fit overflow-hidden rounded-xl border border-border bg-card">
          <div className="space-y-4 p-6">
            {nextDeparture ? (
              <>
                <p className="text-sm text-muted-foreground">Ближайший выезд</p>
                <p className="font-heading text-lg font-semibold text-foreground">
                  {formatDepartureDateRange(nextDeparture.startDate, nextDeparture.endDate)}
                </p>
                <p className="text-sm text-muted-foreground">{formatDurationLabel(nextDeparture.startDate, nextDeparture.endDate)}</p>
                <DepartureStatusBadge status={nextDeparture.bookingStatus} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Дата следующего тура скоро появится</p>
            )}
          </div>

          <div className="border-t border-border bg-muted/40 p-6">
            {nextDeparture?.price !== undefined ? (
              <p className="flex items-baseline gap-2">
                <span className="font-heading text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                  {formatRub(nextDeparture.price)}
                </span>
                <span className="text-sm text-muted-foreground">за человека</span>
              </p>
            ) : (
              <p className="text-base font-medium text-muted-foreground">
                {nextDeparture ? "Цену уточняйте у организатора" : "Цена станет известна вместе с датой"}
              </p>
            )}
            <BookingButton
              departureId={nextDeparture?.bookingStatus === "OPEN" ? nextDeparture.id : undefined}
              tourId={tour.id}
              className="mt-4 w-full"
            />
          </div>
        </aside>
      </div>

      {reports.length > 0 && (
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 className="font-heading mb-6 text-2xl font-semibold text-foreground">Отчёты об этом направлении</h2>
            <div className="scrollbar-none flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2">
              {reports.map((report) => (
                <ReportCard key={report.id} report={report} tourTitle={tour.title} />
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="border-t border-border">
        <ReviewsSection reviews={reviews} />
      </div>
    </article>
  );
}
