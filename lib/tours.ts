import type {
  BookingStatus,
  ContentSnapshot,
  DepartureDTO,
  ImageAsset,
  OrganizerDTO,
  ReportDTO,
  ReviewDTO,
  TourDTO,
} from "./cms/types";

/** Today's calendar date (YYYY-MM-DD) as seen in the given IANA timezone. */
export function getTodayInTimezone(timezone: string, referenceDate: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(referenceDate);
}

export function getTourBySlug(content: ContentSnapshot, slug: string): TourDTO | undefined {
  return content.tours.find((t) => t.slug === slug && t.isListed);
}

export function getTourById(content: ContentSnapshot, id: string): TourDTO | undefined {
  return content.tours.find((t) => t.id === id);
}

export function getDeparturesForTour(content: ContentSnapshot, tourId: string): DepartureDTO[] {
  return content.departures.filter((d) => d.tourId === tourId && d.isListed);
}

function sortByStartDateAsc(a: DepartureDTO, b: DepartureDTO): number {
  return a.startDate.localeCompare(b.startDate);
}

/**
 * Nearest future departure for a tour, regardless of booking status —
 * excluding CANCELLED (section 6/30 of the spec).
 */
export function getNextDeparture(
  content: ContentSnapshot,
  tourId: string,
  today: string,
): DepartureDTO | undefined {
  return getDeparturesForTour(content, tourId)
    .filter((d) => d.bookingStatus !== "CANCELLED" && d.startDate >= today)
    .sort(sortByStartDateAsc)[0];
}

/** Nearest future departure that can actually be booked (bookingStatus === OPEN). */
export function getNextBookableDeparture(
  content: ContentSnapshot,
  tourId: string,
  today: string,
): DepartureDTO | undefined {
  return getDeparturesForTour(content, tourId)
    .filter((d) => d.bookingStatus === "OPEN" && d.startDate >= today)
    .sort(sortByStartDateAsc)[0];
}

export function getDepartureById(content: ContentSnapshot, id: string): DepartureDTO | undefined {
  return content.departures.find((d) => d.id === id);
}

export function getOrganizerById(content: ContentSnapshot, id: string | undefined): OrganizerDTO | undefined {
  if (!id) return undefined;
  return content.organizers.find((o) => o.id === id);
}

export interface ResolvedBooking {
  prepaymentAmount?: number;
  qr?: ImageAsset;
  organizer?: OrganizerDTO;
}

/** Applies the Departure -> SiteSettings.booking fallback chain (section 29). */
export function resolveBookingDetails(content: ContentSnapshot, departure: DepartureDTO): ResolvedBooking {
  const { booking } = content.siteSettings;
  const departureOrganizer = getOrganizerById(content, departure.organizerIds[0]);
  const fallbackOrganizer = getOrganizerById(content, booking.defaultOrganizerId);

  return {
    prepaymentAmount: departure.prepaymentAmount ?? booking.defaultPrepaymentAmount,
    qr: departure.paymentQr ?? booking.defaultQr,
    organizer: departureOrganizer ?? fallbackOrganizer,
  };
}

export function getBookingStatusLabel(status: BookingStatus): string {
  switch (status) {
    case "ANNOUNCED":
      return "Детали уточняются";
    case "OPEN":
      return "Набор открыт";
    case "CLOSED":
      return "Набор закрыт";
    case "CANCELLED":
      return "Поездка отменена";
  }
}

export function formatDepartureDateRange(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  const dayFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", timeZone: "UTC" });
  // day+month (no year) keeps the genitive month form ("30 августа"), unlike
  // a month-only formatter which returns the nominative ("август").
  const dayMonthFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
  const fullFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  const sameMonth = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();

  if (sameMonth) {
    return `${dayFormatter.format(start)}–${fullFormatter.format(end)}`;
  }
  if (sameYear) {
    return `${dayMonthFormatter.format(start)} — ${fullFormatter.format(end)}`;
  }
  return `${fullFormatter.format(start)} — ${fullFormatter.format(end)}`;
}

export function formatDurationLabel(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const nights = Math.max(days - 1, 0);
  const dayLabel = pluralizeRu(days, "день", "дня", "дней");
  const nightLabel = pluralizeRu(nights, "ночь", "ночи", "ночей");
  return `${days} ${dayLabel} / ${nights} ${nightLabel}`;
}

function pluralizeRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function formatSingleDate(date: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function getReportsForTour(content: ContentSnapshot, tourId: string): ReportDTO[] {
  return content.reports
    .filter((r) => r.tourId === tourId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getAllReportsSorted(content: ContentSnapshot): ReportDTO[] {
  return [...content.reports].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (b.date ?? "").localeCompare(a.date ?? "");
  });
}

export function getReportBySlug(content: ContentSnapshot, slug: string): ReportDTO | undefined {
  return content.reports.find((r) => r.slug === slug);
}

export function getReviewsForTour(content: ContentSnapshot, tourId: string): ReviewDTO[] {
  return content.reviews
    .filter((rv) => rv.isListed && rv.tourId === tourId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getAllReviewsSorted(content: ContentSnapshot): ReviewDTO[] {
  return [...content.reviews]
    .filter((rv) => rv.isListed)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getListedTours(content: ContentSnapshot): TourDTO[] {
  return [...content.tours]
    .filter((t) => t.isListed)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** A future departure together with the tour it belongs to — one card in the catalogue. */
export interface UpcomingDeparture {
  departure: DepartureDTO;
  tour: TourDTO;
}

/**
 * Every future departure of every listed tour, soonest first.
 *
 * The public catalogue lists departures rather than tours because price and
 * status belong to a date, not to a destination. ANNOUNCED dates stay visible
 * while their booking details are being confirmed. CANCELLED ones are left
 * out — they stay in the CMS for history and for galleries that link to them,
 * but a cancelled trip is not something a visitor can join.
 */
export function getUpcomingDepartures(content: ContentSnapshot, today: string): UpcomingDeparture[] {
  const tourById = new Map(getListedTours(content).map((t) => [t.id, t]));

  return content.departures
    .filter(
      (d) => d.isListed && d.bookingStatus !== "CANCELLED" && d.startDate >= today && tourById.has(d.tourId),
    )
    .sort(sortByStartDateAsc)
    .map((departure) => ({ departure, tour: tourById.get(departure.tourId)! }));
}


// ---------------------------------------------------------------------------
// Data for the client-side Booking Modal (section 16-20): a small, serializable
// slice of the content snapshot with the booking fallback chain already applied.
// ---------------------------------------------------------------------------

export interface BookingDepartureInfo {
  id: string;
  tourId: string;
  tourTitle: string;
  startDate: string;
  endDate: string;
  prepaymentAmount?: number;
  qr?: ImageAsset;
  organizerName?: string;
  organizerPhone?: string;
}

/**
 * Contact-only — deliberately has no prepaymentAmount/qr fields. Without a
 * resolved OPEN departure there's nothing concrete to pay for, so the
 * booking modal must never show a QR/amount for an unspecified trip — a
 * visitor could otherwise transfer money against a departure that does not
 * exist. Making this type contact-only turns that into a structural guarantee
 * instead of a convention the modal has to uphold on its own.
 */
export interface BookingFallback {
  organizerName?: string;
  organizerPhone?: string;
}

/** Every currently-bookable (OPEN, listed, future) departure across the whole site. */
export function getAllBookableDepartures(content: ContentSnapshot, today: string): BookingDepartureInfo[] {
  return content.departures
    .filter((d) => d.isListed && d.bookingStatus === "OPEN" && d.startDate >= today)
    .map((d) => {
      const tour = getTourById(content, d.tourId);
      const resolved = resolveBookingDetails(content, d);
      return {
        id: d.id,
        tourId: d.tourId,
        tourTitle: tour?.title ?? "",
        startDate: d.startDate,
        endDate: d.endDate,
        prepaymentAmount: resolved.prepaymentAmount,
        qr: resolved.qr,
        organizerName: resolved.organizer?.name,
        organizerPhone: resolved.organizer?.phone,
      };
    });
}

/** siteSettings.booking's default organizer contact, shown when no departure could be resolved at all. */
export function getBookingFallback(content: ContentSnapshot): BookingFallback {
  const organizer = getOrganizerById(content, content.siteSettings.booking.defaultOrganizerId);
  return {
    organizerName: organizer?.name,
    organizerPhone: organizer?.phone,
  };
}
