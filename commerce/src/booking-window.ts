// Owner policy: online sales end exactly 24 elapsed hours before local departure.
import { zonedToUtc } from './snapshot.js';
export const BOOKING_CUTOFF_HOURS = 24;
export function bookingCutoff(startsOn: string, time: string, timezone: string): Date {
  return bookingCutoffAt(zonedToUtc(startsOn,time,timezone));
}
export function bookingCutoffAt(serviceStartsAt: string): Date {
  return new Date(Date.parse(serviceStartsAt)-BOOKING_CUTOFF_HOURS*3_600_000);
}
