import assert from "node:assert/strict";
import test from "node:test";

import type { BookingDepartureInfo } from "./tours";
import { selectBookingDeparture } from "./booking";

const departures: BookingDepartureInfo[] = [
  {
    id: "krasnoyarsk-september",
    tourId: "krasnoyarsk",
    tourTitle: "Красноярск",
    startDate: "2026-09-25",
    endDate: "2026-09-27",
  },
  {
    id: "altai-november",
    tourId: "altai",
    tourTitle: "Алтай",
    startDate: "2026-11-10",
    endDate: "2026-11-13",
  },
  {
    id: "altai-october",
    tourId: "altai",
    tourTitle: "Алтай",
    startDate: "2026-10-10",
    endDate: "2026-10-13",
  },
];

test("booking resolves the exact departure named by the CTA", () => {
  assert.equal(selectBookingDeparture(departures, "altai-november")?.id, "altai-november");
});

test("an unknown departure never falls back to another trip", () => {
  assert.equal(selectBookingDeparture(departures, "closed-departure"), null);
});
