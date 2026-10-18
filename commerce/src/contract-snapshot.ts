// The order's own contract (ADR v2.3 §3, migration 0008): the buyer's whole resolved offer, stored
// on the order when it is reserved and never changed after. Price, programme, route, accommodation
// with its registry facts, carrier, included and excluded services, schedule and meeting points.
// With the offer and PD consent already frozen on the order, it is what every later document is
// rendered from, never the current departure, which stays editable.
//
// The database checks the shape and that it agrees with the order's own columns
// (fn_order_contract_snapshot_valid); the hash is sha256 of its RFC 8785 form, as every other hash
// this service computes, so it does not depend on how PostgreSQL prints jsonb.

import { createHash } from 'node:crypto';

import type { Bookable, Departure } from './catalog.js';
import { canonical, type Json } from './snapshot.js';

export const CONTRACT_SNAPSHOT_SCHEMA = 'mikluha.order-contract/1';

export interface ContractSnapshot {
  readonly schema: typeof CONTRACT_SNAPSHOT_SCHEMA;
  readonly tourSlug: string;
  readonly tourTitle: string;
  readonly departureSlug: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly timezone: string;
  readonly unitPriceKopecks: number;
  readonly currency: 'RUB';
  readonly contract: NonNullable<Departure['contract']>;
}

/** What a buyer of `departure` accepts now, in `timezone`. Explicit fields: nothing extra leaks in. */
export function buildContractSnapshot(departure: Bookable, timezone: string): ContractSnapshot {
  const { tour, departure: dc } = departure.contract;
  return {
    schema: CONTRACT_SNAPSHOT_SCHEMA,
    tourSlug: departure.tourSlug, tourTitle: departure.tourTitle, departureSlug: departure.slug,
    startsOn: departure.startsOn, endsOn: departure.endsOn, timezone,
    unitPriceKopecks: departure.priceKopecks, currency: 'RUB',
    contract: {
      tour: { destination: tour.destination, route: tour.route,
        program: tour.program.map((d) => ({ title: d.title, items: [...d.items] })),
        included: [...tour.included], excluded: [...tour.excluded], insurance: tour.insurance, risks: tour.risks },
      departure: {
        departureTime: dc.departureTime, returnTime: dc.returnTime, departurePoint: dc.departurePoint, returnPoint: dc.returnPoint,
        accommodation: { name: dc.accommodation.name, address: dc.accommodation.address, category: dc.accommodation.category,
          registryNumber: dc.accommodation.registryNumber, roomType: dc.accommodation.roomType, nights: dc.accommodation.nights,
          meals: dc.accommodation.meals, legalEntity: dc.accommodation.legalEntity },
        carrier: { legalName: dc.carrier.legalName, route: dc.carrier.route, vehicle: dc.carrier.vehicle,
          baggage: dc.carrier.baggage, boarding: dc.carrier.boarding },
        services: dc.services.map((x) => ({ name: x.name, supplier: x.supplier, included: x.included, note: x.note })),
      },
    },
  };
}

/** `sha256:<hex>` of the snapshot's canonical form. */
export function contractSnapshotHash(snapshot: ContractSnapshot): string {
  return `sha256:${createHash('sha256').update(canonical(snapshot as unknown as Json), 'utf8').digest('hex')}`;
}

/** Whether a stored snapshot still is what its stored hash says: documents render only from one that is. */
export function contractSnapshotIntact(snapshot: unknown, hash: string | null): snapshot is ContractSnapshot {
  if (snapshot === null || typeof snapshot !== 'object' || hash === null) return false;
  if ((snapshot as { schema?: unknown }).schema !== CONTRACT_SNAPSHOT_SCHEMA) return false;
  try {
    return contractSnapshotHash(snapshot as ContractSnapshot) === hash;
  } catch {
    return false;
  }
}
