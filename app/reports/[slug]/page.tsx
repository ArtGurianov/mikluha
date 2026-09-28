import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookingButton } from "@/components/booking/booking-button";
import { Gallery } from "@/components/gallery/gallery";
import { HeroMedia } from "@/components/home/hero-media";
import { CmsImage } from "@/components/media/cms-image";
import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { getContent } from "@/lib/cms/content";
import { jsonLdScript } from "@/lib/json-ld";
import { isStaging, resolveCanonicalBase } from "@/lib/site";
import { buildBreadcrumbJsonLd, getReportBreadcrumbs } from "@/lib/structured-data";
import {
  formatDepartureDateRange,
  formatSingleDate,
  getNextBookableDeparture,
  getReportBySlug,
  getTodayInTimezone,
  getTourById,
} from "@/lib/tours";

export function generateStaticParams() {
  const content = getContent();
  return content.reports.map((report) => ({ slug: report.slug }));
}

export async function generateMetadata(props: PageProps<"/reports/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const content = getContent();
  const report = getReportBySlug(content, slug);
  if (!report) return {};

  const tour = getTourById(content, report.tourId);
  const title = `${report.title} — ${tour?.title ?? ""}`;
  const description = report.description ?? tour?.shortDescription ?? report.title;

  return {
    title,
    description,
    alternates: { canonical: `/reports/${report.slug}/` },
    openGraph: { title, description, images: [{ url: report.coverImage.src }] },
    // A thin report stays on the site as social proof but out of the index;
    // `follow` keeps its links to the tour counting. Staging stays
    // noindex/nofollow from the root layout regardless.
    ...(report.noindex && !isStaging ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function ReportPage(props: PageProps<"/reports/[slug]">) {
  const { slug } = await props.params;
  const content = getContent();
  const report = getReportBySlug(content, slug);
  if (!report) notFound();

  const tour = getTourById(content, report.tourId);
  const today = getTodayInTimezone(content.siteSettings.timezone);
  const nextBookable = tour ? getNextBookableDeparture(content, tour.id, today) : undefined;
  const breadcrumbs = getReportBreadcrumbs(report, tour);
  const breadcrumbJsonLd = buildBreadcrumbJsonLd(breadcrumbs, resolveCanonicalBase(content.siteSettings.siteUrl));

  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(breadcrumbJsonLd) }} />
      <div className="relative flex h-[45vh] min-h-80 items-end text-white">
        <CmsImage
          image={report.coverImage}
          loading="eager"
          fetchPriority="high"
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
        <div className="relative z-10 mx-auto w-full max-w-4xl space-y-1 px-4 pb-10 sm:px-6">
          <Breadcrumbs crumbs={breadcrumbs} />
          {report.date && <p className="text-sm text-white/70">{formatSingleDate(report.date)}</p>}
          <h1 className="font-heading text-3xl font-semibold sm:text-4xl">{report.title}</h1>
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-8 px-4 py-12 sm:px-6">
        {report.description && <p className="text-lg text-foreground/90">{report.description}</p>}

        <Gallery images={report.gallery} />
      </div>

      {tour && (
        <section className="relative border-t border-border bg-primary text-primary-foreground">
          {/* Below the fold: must not compete with the report cover, the page's LCP. */}
          <HeroMedia image={content.siteSettings.hero.image} video={content.siteSettings.hero.video} lazy />
          <div className="absolute inset-0 bg-linear-to-bl from-secondary/90 to-primary/70" />
          <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center gap-3 px-4 py-14 text-center sm:px-6">
            <p className="font-heading text-2xl font-semibold">Давай с нами?</p>
            {nextBookable ? (
              <p className="text-primary-foreground/85">
                Следующая поездка на {tour.title} —{" "}
                <span className="font-medium text-primary-foreground">
                  {formatDepartureDateRange(nextBookable.startDate, nextBookable.endDate)}
                </span>
              </p>
            ) : (
              <p className="text-primary-foreground/85">Дата следующего тура скоро появится</p>
            )}
            {nextBookable && (
              <BookingButton
                departureId={nextBookable.id}
                size="lg"
                className="mt-2 h-auto px-6 py-3 text-2xl"
              />
            )}
          </div>
        </section>
      )}
    </article>
  );
}
