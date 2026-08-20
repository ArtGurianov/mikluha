import type { BookingDepartureInfo } from "./tours";

export function selectBookingDeparture(
  departures: BookingDepartureInfo[],
  departureId: string,
): BookingDepartureInfo | null {
  return departures.find((departure) => departure.id === departureId) ?? null;
}
