// What can be sold, read from the site's own content/ (the same YAML the static build reads).
//
// The service is built from the same commit as the content, so a published price change reaches it
// with its next deploy; an order freezes its price when it is created and never re-reads it.
// Fail-closed: a departure is bookable only when everything below holds, and any malformed file
// stops the service from starting rather than selling something half-described.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import yaml from 'js-yaml';

/** What every departure of a tour shares in the contract: the program and the tour's conditions. */
export interface TourContract {
  readonly destination: string;
  readonly route: string;
  readonly program: readonly { readonly title: string; readonly items: readonly string[] }[];
  readonly included: readonly string[];
  readonly excluded: readonly string[];
  readonly insurance: string | null;
  readonly risks: string;
}

/** What one departure adds: where and when, where the tourists sleep, who carries them, what else. */
export interface DepartureContract {
  readonly departurePoint: string;
  readonly returnPoint: string;
  readonly accommodation: {
    readonly name: string; readonly address: string; readonly category: string | null; readonly registryNumber: string | null;
    readonly roomType: string; readonly nights: number; readonly meals: string; readonly legalEntity: string;
  };
  readonly carrier: { readonly legalName: string; readonly route: string; readonly vehicle: string | null; readonly baggage: string; readonly boarding: string };
  readonly services: readonly { readonly name: string; readonly supplier: string; readonly included: boolean; readonly note: string | null }[];
}

export interface Departure {
  readonly slug: string;
  readonly tourSlug: string;
  readonly tourTitle: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly bookingStatus: 'OPEN' | 'CLOSED' | 'CANCELLED';
  /** Full trip price per person, the amount paid online (never prepaymentAmount: ART-47 decision). */
  readonly priceKopecks: number | null;
  readonly capacity: number | null;
  /** Null until both the tour and the departure carry every contract field: then it cannot be sold. */
  readonly contract: { readonly tour: TourContract; readonly departure: DepartureContract } | null;
  readonly isListed: boolean;
  readonly isDemo: boolean;
}

/** The public offer (content/legal/oferta.yml): the contract every order is concluded under. */
export interface BookingTerms {
  /** `<slug>@<updatedAt>`: names the published version of the offer. */
  readonly ref: string;
  /** `sha256:<hex>` of the exact text the customer is shown. */
  readonly hash: string;
  readonly text: string;
}

export interface Catalog {
  readonly timezone: string;
  readonly launchReady: boolean;
  readonly departures: ReadonlyMap<string, Departure>;
  readonly terms: BookingTerms;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function load(file: string): Record<string, unknown> {
  // JSON_SCHEMA, as the site reads it (lib/cms/content-yaml.ts): an unquoted 2026-06-15 stays a string.
  const doc = yaml.load(readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA });
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`CATALOG_INVALID: ${file} is not a mapping`);
  return doc as Record<string, unknown>;
}

function str(doc: Record<string, unknown>, key: string, where: string): string {
  const v = doc[key];
  if (typeof v !== 'string' || v === '') throw new Error(`CATALOG_INVALID: ${where} ${key}`);
  return v;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const lines = (v: unknown): string[] => (text(v) ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
const record = (v: unknown): Record<string, unknown> =>
  (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Complete, or null: a contract with a hole in it is never sold. */
export function tourContract(raw: unknown): TourContract | null {
  const c = record(raw);
  const program = Array.isArray(c.program) ? c.program.map((d) => ({ title: text(record(d).title), items: lines(record(d).items) })) : [];
  const destination = text(c.destination);
  const route = text(c.route);
  const risks = text(c.risks);
  const included = lines(c.included);
  if (destination === null || route === null || risks === null || included.length === 0 || program.length === 0
    || program.some((d) => d.title === null || d.items.length === 0)) return null;
  return { destination, route, risks, included, excluded: lines(c.excluded), insurance: text(c.insurance),
    program: program.map((d) => ({ title: d.title!, items: d.items })) };
}

export function departureContract(raw: unknown): DepartureContract | null {
  const c = record(raw);
  const a = record(c.accommodation);
  const k = record(c.carrier);
  const req = [c.departurePoint, c.returnPoint, a.name, a.address, a.roomType, a.meals, a.legalEntity,
    k.legalName, k.route, k.baggage, k.boarding].map(text);
  const nights = a.nights;
  if (req.some((v) => v === null) || typeof nights !== 'number' || !Number.isSafeInteger(nights) || nights < 0) return null;
  const services = Array.isArray(c.services) ? c.services.map((x) => {
    const r = record(x);
    return { name: text(r.name), supplier: text(r.supplier), included: r.included !== false, note: text(r.note) };
  }) : [];
  if (services.some((x) => x.name === null || x.supplier === null)) return null;
  const [departurePoint, returnPoint, name, address, roomType, meals, legalEntity, legalName, route, baggage, boarding] = req as string[];
  return {
    departurePoint: departurePoint!, returnPoint: returnPoint!,
    accommodation: { name: name!, address: address!, category: text(a.category), registryNumber: text(a.registryNumber),
      roomType: roomType!, nights, meals: meals!, legalEntity: legalEntity! },
    carrier: { legalName: legalName!, route: route!, vehicle: text(k.vehicle), baggage: baggage!, boarding: boarding! },
    services: services.map((x) => ({ name: x.name!, supplier: x.supplier!, included: x.included, note: x.note })),
  };
}

function optInt(doc: Record<string, unknown>, key: string, where: string, min: number): number | null {
  const v = doc[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new Error(`CATALOG_INVALID: ${where} ${key}`);
  return v;
}

export function loadCatalog(contentDir: string): Catalog {
  const settings = load(join(contentDir, 'site-settings.yml'));
  const timezone = str(settings, 'timezone', 'site-settings');
  const tours = new Map<string, { title: string; contract: TourContract | null }>();
  for (const f of readdirSync(join(contentDir, 'tours')).filter((x) => x.endsWith('.yml'))) {
    const t = load(join(contentDir, 'tours', f));
    tours.set(str(t, 'slug', f), { title: str(t, 'title', f), contract: tourContract(t.contract) });
  }
  const departures = new Map<string, Departure>();
  for (const f of readdirSync(join(contentDir, 'departures')).filter((x) => x.endsWith('.yml'))) {
    const slug = basename(f, '.yml');
    const d = load(join(contentDir, 'departures', f));
    const tourSlug = str(d, 'tour', slug);
    const tour = tours.get(tourSlug);
    if (tour === undefined) throw new Error(`CATALOG_INVALID: ${slug} names unknown tour ${tourSlug}`);
    const dc = departureContract(d.contract);
    const startsOn = str(d, 'startDate', slug);
    const endsOn = str(d, 'endDate', slug);
    if (!DATE.test(startsOn) || !DATE.test(endsOn) || endsOn < startsOn) throw new Error(`CATALOG_INVALID: ${slug} dates`);
    const status = d.bookingStatus;
    if (status !== 'OPEN' && status !== 'CLOSED' && status !== 'CANCELLED') throw new Error(`CATALOG_INVALID: ${slug} bookingStatus`);
    const price = optInt(d, 'price', slug, 1);
    departures.set(slug, {
      slug, tourSlug, tourTitle: tour.title, startsOn, endsOn, bookingStatus: status,
      priceKopecks: price === null ? null : price * 100,
      capacity: optInt(d, 'capacity', slug, 1),
      contract: tour.contract !== null && dc !== null ? { tour: tour.contract, departure: dc } : null,
      // Visibility is fail-closed on the site too: only an explicit true.
      isListed: d.isListed === true,
      isDemo: d.isDemo === true,
    });
  }
  const offer = load(join(contentDir, 'legal', 'oferta.yml'));
  const offerText = str(offer, 'content', 'oferta');
  const terms: BookingTerms = {
    ref: `${str(offer, 'slug', 'oferta')}@${str(offer, 'updatedAt', 'oferta')}`,
    hash: `sha256:${createHash('sha256').update(offerText, 'utf8').digest('hex')}`,
    text: offerText,
  };
  return { timezone, launchReady: settings.launchReady === true, departures, terms };
}

/** Today's date in the site's timezone, as YYYY-MM-DD. */
export function todayIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export type NotBookable =
  | 'DEPARTURE_UNKNOWN' | 'DEPARTURE_NOT_OPEN' | 'DEPARTURE_NOT_LISTED' | 'DEPARTURE_DEMO'
  | 'DEPARTURE_NO_PRICE' | 'DEPARTURE_NO_CAPACITY' | 'DEPARTURE_NO_CONTRACT' | 'DEPARTURE_STARTED';

export interface Bookable extends Departure {
  readonly priceKopecks: number;
  readonly capacity: number;
  readonly contract: NonNullable<Departure['contract']>;
}

/**
 * Whether new seats may be sold for this departure now. Demo departures are sellable only where the
 * deployment allows them (staging), never in production.
 */
export function bookable(catalog: Catalog, slug: string, now: Date, allowDemo: boolean): Bookable | NotBookable {
  const d = catalog.departures.get(slug);
  if (d === undefined) return 'DEPARTURE_UNKNOWN';
  if (d.bookingStatus !== 'OPEN') return 'DEPARTURE_NOT_OPEN';
  if (!d.isListed) return 'DEPARTURE_NOT_LISTED';
  if (d.isDemo && !allowDemo) return 'DEPARTURE_DEMO';
  if (d.priceKopecks === null) return 'DEPARTURE_NO_PRICE';
  if (d.capacity === null) return 'DEPARTURE_NO_CAPACITY';
  if (d.contract === null) return 'DEPARTURE_NO_CONTRACT';
  if (d.startsOn <= todayIn(catalog.timezone, now)) return 'DEPARTURE_STARTED';
  return d as Bookable;
}
