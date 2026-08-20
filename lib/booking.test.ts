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

test("a generic booking CTA stays neutral", () => {
  assert.equal(selectBookingDeparture(departures), null);
  assert.equal(selectBookingDeparture(departures, {}), null);
});

test("an exact departure takes precedence", () => {
  assert.equal(
    selectBookingDeparture(departures, {
      departureId: "altai-november",
      tourId: "krasnoyarsk",
    })?.id,
    "altai-november",
  );
});

test("a tour CTA selects only that tour's nearest departure", () => {
  assert.equal(selectBookingDeparture(departures, { tourId: "altai" })?.id, "altai-october");
});

test("an unknown exact departure never falls back to another trip", () => {
  assert.equal(selectBookingDeparture(departures, { departureId: "closed-departure" }), null);
});
