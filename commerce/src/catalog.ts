// Shared contract types/parsers and code-owned settings/legal release.
// The catalog is supplied by PostgreSQL public projections, never Git/YAML.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { bookingCutoff } from './booking-window.js';

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
  readonly departureTime: string;
  readonly returnTime: string;
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
  /** Full trip price per person: online checkout never collects a partial advance. */
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

/** A separate authorization artifact: never folded into the tourism contract hash sent to Refref. */
export interface PersonalDataConsent {
  readonly ref: string;
  readonly hash: string;
  readonly text: string;
}

export interface Catalog {
  readonly refundPolicy: 'FULL_ONLY' | 'DOCUMENTED_EXPENSES';
  readonly timezone: string;
  readonly launchReady: boolean;
  readonly departures: ReadonlyMap<string, Departure>;
  readonly terms: BookingTerms;
  readonly pdConsent: PersonalDataConsent;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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

/**
 * An exact, canonically spelled IANA zone, or a refusal. Never substitutes a default: a missing or
 * invalid site timezone stops the catalog instead of silently becoming Europe/Moscow or UTC.
 */
export function ianaTimezone(value: string, where: string): string {
  let resolved: string;
  try { resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error(`CATALOG_INVALID: ${where} timezone`); }
  if (resolved !== value || !value.includes('/')) throw new Error(`CATALOG_INVALID: ${where} timezone`);
  return value;
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
  const departureTime = text(c.departureTime);
  const returnTime = text(c.returnTime);
  if (departureTime === null || returnTime === null || !TIME.test(departureTime) || !TIME.test(returnTime)) return null;
  if (req.some((v) => v === null) || typeof nights !== 'number' || !Number.isSafeInteger(nights) || nights < 0) return null;
  const services = Array.isArray(c.services) ? c.services.map((x) => {
    const r = record(x);
    return { name: text(r.name), supplier: text(r.supplier), included: r.included, note: text(r.note) };
  }) : [];
  if (services.some((x) => x.name === null || x.supplier === null || typeof x.included !== 'boolean')) return null;
  const [departurePoint, returnPoint, name, address, roomType, meals, legalEntity, legalName, route, baggage, boarding] = req as string[];
  return {
    departureTime, returnTime,
    departurePoint: departurePoint!, returnPoint: returnPoint!,
    accommodation: { name: name!, address: address!, category: text(a.category), registryNumber: text(a.registryNumber),
      roomType: roomType!, nights, meals: meals!, legalEntity: legalEntity! },
    carrier: { legalName: legalName!, route: route!, vehicle: text(k.vehicle), baggage: baggage!, boarding: boarding! },
    services: services.map((x) => ({ name: x.name!, supplier: x.supplier!, included: x.included as boolean, note: x.note })),
  };
}

export function loadSiteRelease(contentDir: string): Catalog {
  const settings = load(join(contentDir, 'site-settings.yml'));
  const timezone = ianaTimezone(str(settings, 'timezone', 'site-settings'), 'site-settings');
  const departures = new Map<string, Departure>();
  const artifact = (slug: string): BookingTerms => {
    const page = load(join(contentDir, 'legal', `${slug}.yml`));
    const content = str(page, 'content', slug);
    return {
      ref: `${str(page, 'slug', slug)}@${str(page, 'updatedAt', slug)}`,
      hash: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
      text: content,
    };
  };
  const terms = artifact('oferta');
  const pdConsent = artifact('soglasie-pd');
  const refundPolicy = load(join(contentDir, 'legal', 'oferta.yml')).refundPolicy;
  if (refundPolicy !== 'FULL_ONLY' && refundPolicy !== 'DOCUMENTED_EXPENSES') throw new Error('CATALOG_INVALID: oferta refundPolicy');
  return { timezone, refundPolicy, launchReady: settings.launchReady === true, departures, terms, pdConsent };
}

/** No flag/configuration can qualify a new financial workflow. A separately reviewed change must. */
export function refundWorkflowQualified(catalog: Catalog): boolean {
  return catalog.refundPolicy === 'FULL_ONLY';
}

export function assertProductionContent(catalog: Catalog): void {
  if (!refundWorkflowQualified(catalog)) throw new Error('REFUND_WORKFLOW_UNQUALIFIED: documented-expense refunds require separate end-to-end qualification');
  if (!catalog.launchReady) throw new Error('CONTENT_NOT_LAUNCH_READY: production serves launchReady content only');
}

/** Today's date in the site's timezone, as YYYY-MM-DD. */
export function todayIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export type NotBookable =
  | 'DEPARTURE_UNKNOWN' | 'DEPARTURE_NOT_OPEN' | 'DEPARTURE_NOT_LISTED' | 'DEPARTURE_DEMO'
  | 'BOOKING_CUTOFF_REACHED' | 'DEPARTURE_NO_PRICE' | 'DEPARTURE_NO_CAPACITY' | 'DEPARTURE_NO_CONTRACT' | 'DEPARTURE_STARTED' | 'REFUND_WORKFLOW_UNQUALIFIED';

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
  if (!refundWorkflowQualified(catalog)) return 'REFUND_WORKFLOW_UNQUALIFIED';
  const d = catalog.departures.get(slug);
  if (d === undefined) return 'DEPARTURE_UNKNOWN';
  if (d.bookingStatus !== 'OPEN') return 'DEPARTURE_NOT_OPEN';
  if (!d.isListed) return 'DEPARTURE_NOT_LISTED';
  if (d.isDemo && !allowDemo) return 'DEPARTURE_DEMO';
  if (d.priceKopecks === null) return 'DEPARTURE_NO_PRICE';
  if (d.capacity === null) return 'DEPARTURE_NO_CAPACITY';
  if (d.contract === null) return 'DEPARTURE_NO_CONTRACT';
  if (bookingCutoff(d.startsOn, d.contract.departure.departureTime, catalog.timezone) <= now) return 'BOOKING_CUTOFF_REACHED';
  return d as Bookable;
}
