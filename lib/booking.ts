import type { BookingDepartureInfo } from "./tours";

export interface BookingTarget {
  departureId?: string;
  tourId?: string;
}

/**
 * Resolves only an explicitly named date or tour. A generic CTA deliberately
 * stays neutral instead of silently presenting the first trip on the site.
 */
export function selectBookingDeparture(
  departures: BookingDepartureInfo[],
  target?: BookingTarget,
): BookingDepartureInfo | null {
  if (target?.departureId) {
    return departures.find((departure) => departure.id === target.departureId) ?? null;
  }

  if (!target?.tourId) return null;

  return (
    departures
      .filter((departure) => departure.tourId === target.tourId)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null
  );
}
