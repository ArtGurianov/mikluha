import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookingButton } from "@/components/booking/booking-button";
import { Gallery } from "@/components/gallery/gallery";
import { CmsImage } from "@/components/media/cms-image";
import { getContent } from "@/lib/cms/content";
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

  return (
    <article>
      <div className="relative flex h-[45vh] min-h-80 items-end text-white">
        <CmsImage
          image={report.coverImage}
          loading="eager"
          fetchPriority="high"
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
        <div className="relative z-10 mx-auto w-full max-w-4xl space-y-1 px-4 pb-10 sm:px-6">
          {tour && tour.isListed ? (
            <Link href={`/tours/${tour.slug}/`} className="text-sm font-medium tracking-wide text-white/80 uppercase hover:underline">
              {tour.title}
            </Link>
          ) : (
            tour && <p className="text-sm font-medium tracking-wide text-white/80 uppercase">{tour.title}</p>
          )}
          {report.date && <p className="text-sm text-white/70">{formatSingleDate(report.date)}</p>}
          <h1 className="font-heading text-3xl font-semibold sm:text-4xl">{report.title}</h1>
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-8 px-4 py-12 sm:px-6">
        {report.description && <p className="text-lg text-foreground/90">{report.description}</p>}

        <Gallery images={report.gallery} />
      </div>

      {tour && (
        <section className="border-t border-border bg-muted/40">
          <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 px-4 py-14 text-center sm:px-6">
            <p className="font-heading text-2xl font-semibold text-foreground">Хотите увидеть эти места?</p>
            {nextBookable ? (
              <p className="text-muted-foreground">
                Следующая поездка на {tour.title} —{" "}
                <span className="font-medium text-foreground">
                  {formatDepartureDateRange(nextBookable.startDate, nextBookable.endDate)}
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground">Дата следующего тура скоро появится</p>
            )}
            <BookingButton tourId={tour.id} size="lg" className="mt-2 h-auto px-6 py-3 text-2xl" />
          </div>
        </section>
      )}
    </article>
  );
}
