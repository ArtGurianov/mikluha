import type { ContentSnapshot, TourDTO } from "./cms/types";
import { getDeparturesForTour, getListedTours, getReportsForTour } from "./tours";

/**
 * Sitemap `lastmod` per page: the date of its last *significant* change, or
 * `undefined` when nothing tells us — never the build time. Search engines
 * trust `lastmod` only while it stays accurate, and stamping every URL with
 * the build time on every rebuild (including the scheduled date-change ones)
 * is exactly how a sitemap loses that trust.
 *
 * All dates are YYYY-MM-DD. Anything after `today` (a typo in the CMS) is
 * ignored rather than published as a modification from the future.
 */

function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function latest(dates: Array<string | undefined>, today: string): string | undefined {
  let result: string | undefined;
  for (const date of dates) {
    if (date && date <= today && (!result || date > result)) result = date;
  }
  return result;
}

/**
 * /tours/<slug>/ changes when the tour or one of its reports is edited, when
 * one of its departures is edited while it is still on the page (an edit made
 * after the trip started changes nothing a visitor can see), and — with no
 * edit at all — the day after a departure starts: from then on the page shows
 * a different nearest date, price and booking state. A cancelled departure is
 * never shown, so it has no such day.
 */
export function getTourLastModified(content: ContentSnapshot, tour: TourDTO, today: string): string | undefined {
  const departureDates = getDeparturesForTour(content, tour.id).flatMap((d) => [
    d.updatedAt && d.updatedAt <= d.startDate ? d.updatedAt : undefined,
    d.bookingStatus === "CANCELLED" ? undefined : dayAfter(d.startDate),
  ]);

  return latest(
    [tour.updatedAt, ...departureDates, ...getReportsForTour(content, tour.id).map((r) => r.updatedAt)],
    today,
  );
}

/** The home page lists every tour's departures and every report. */
export function getHomeLastModified(content: ContentSnapshot, today: string): string | undefined {
  return latest(
    [
      ...getListedTours(content).map((tour) => getTourLastModified(content, tour, today)),
      ...content.reports.map((r) => r.updatedAt),
    ],
    today,
  );
}

export function getDocumentLastModified(document: { updatedAt?: string }, today: string): string | undefined {
  return latest([document.updatedAt], today);
}
