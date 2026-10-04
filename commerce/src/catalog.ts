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
  readonly requiresDateOfBirth: boolean;
  readonly isListed: boolean;
  readonly isDemo: boolean;
}

export interface BookingTerms {
  /** `<slug>@<updatedAt>`: names the published version of the terms. */
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

function optInt(doc: Record<string, unknown>, key: string, where: string, min: number): number | null {
  const v = doc[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new Error(`CATALOG_INVALID: ${where} ${key}`);
  return v;
}

export function loadCatalog(contentDir: string): Catalog {
  const settings = load(join(contentDir, 'site-settings.yml'));
  const timezone = str(settings, 'timezone', 'site-settings');
  const tours = new Map<string, string>();
  for (const f of readdirSync(join(contentDir, 'tours')).filter((x) => x.endsWith('.yml'))) {
    const t = load(join(contentDir, 'tours', f));
    tours.set(str(t, 'slug', f), str(t, 'title', f));
  }
  const departures = new Map<string, Departure>();
  for (const f of readdirSync(join(contentDir, 'departures')).filter((x) => x.endsWith('.yml'))) {
    const slug = basename(f, '.yml');
    const d = load(join(contentDir, 'departures', f));
    const tourSlug = str(d, 'tour', slug);
    const tourTitle = tours.get(tourSlug);
    if (tourTitle === undefined) throw new Error(`CATALOG_INVALID: ${slug} names unknown tour ${tourSlug}`);
    const startsOn = str(d, 'startDate', slug);
    const endsOn = str(d, 'endDate', slug);
    if (!DATE.test(startsOn) || !DATE.test(endsOn) || endsOn < startsOn) throw new Error(`CATALOG_INVALID: ${slug} dates`);
    const status = d.bookingStatus;
    if (status !== 'OPEN' && status !== 'CLOSED' && status !== 'CANCELLED') throw new Error(`CATALOG_INVALID: ${slug} bookingStatus`);
    const price = optInt(d, 'price', slug, 1);
    departures.set(slug, {
      slug, tourSlug, tourTitle, startsOn, endsOn, bookingStatus: status,
      priceKopecks: price === null ? null : price * 100,
      capacity: optInt(d, 'capacity', slug, 1),
      requiresDateOfBirth: d.requiresDateOfBirth === true,
      // Visibility is fail-closed on the site too: only an explicit true.
      isListed: d.isListed === true,
      isDemo: d.isDemo === true,
    });
  }
  const termsDoc = load(join(contentDir, 'legal', 'booking-terms.yml'));
  const text = str(termsDoc, 'content', 'booking-terms');
  const terms: BookingTerms = {
    ref: `${str(termsDoc, 'slug', 'booking-terms')}@${str(termsDoc, 'updatedAt', 'booking-terms')}`,
    hash: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    text,
  };
  return { timezone, launchReady: settings.launchReady === true, departures, terms };
}

/** Today's date in the site's timezone, as YYYY-MM-DD. */
export function todayIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export type NotBookable =
  | 'DEPARTURE_UNKNOWN' | 'DEPARTURE_NOT_OPEN' | 'DEPARTURE_NOT_LISTED' | 'DEPARTURE_DEMO'
  | 'DEPARTURE_NO_PRICE' | 'DEPARTURE_NO_CAPACITY' | 'DEPARTURE_STARTED';

export interface Bookable extends Departure { readonly priceKopecks: number; readonly capacity: number }

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
  if (d.startsOn <= todayIn(catalog.timezone, now)) return 'DEPARTURE_STARTED';
  return d as Bookable;
}
