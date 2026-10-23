// The public projection (ADR v2.3 §2, migration 0009): what the SSR site renders on request and what
// a new quote is priced from. Only published, explicitly listed content whose relations are listed
// too; drafts and history never reach it. The service reads it as commerce_app through the public_*
// views, so each render and each new quote sees the latest publish, and nothing else.

import type pg from 'pg';

import { bookable, type Bookable, type NotBookable, type Catalog, type Departure, type DepartureContract, type TourContract } from './catalog.js';
import type { Json } from './editorial.js';

export interface PublicTour {
  readonly slug: string;
  readonly title: string;
  readonly content: { [key: string]: Json };
  readonly publishedVersion: number;
}

/** A published, listed departure in the shape the checkout already sells (catalog.ts Departure). */
export interface PublicDeparture extends Departure {
  readonly timezone: string;
  readonly departureTime: string;
  readonly returnTime: string;
  readonly content: { [key: string]: Json };
  /** The departure_revision the page shows; a quote binds to it (ART-362). */
  readonly publishedVersion: number;
  readonly organizers: readonly string[];
}

export interface PublicContentItem {
  readonly slug: string;
  readonly content: { [key: string]: Json };
  readonly publishedVersion: number;
}
export interface PublicReport extends PublicContentItem {
  readonly title: string; readonly tourSlug: string; readonly departureSlug: string | null;
  readonly date: string | null; readonly noindex: boolean;
}
export interface PublicReview extends PublicContentItem {
  readonly authorName: string; readonly tourSlug: string | null; readonly isDemo: boolean;
}
export interface PublicOrganizer extends PublicContentItem {
  readonly name: string; readonly isDemo: boolean;
}

interface DepartureRow {
  slug: string; tour_slug: string; tour_title: string; starts_on: string; ends_on: string; departure_time: string;
  return_time: string; timezone: string; price_kopecks: string | null; capacity: number | null;
  contract: { tour: TourContract | null; departure: Omit<DepartureContract, 'departureTime' | 'returnTime'> | null } | null;
  contract_complete: boolean; content: { [key: string]: Json }; booking_status: Departure['bookingStatus'];
  is_demo: boolean; published_version: number; organizers: string[];
}

const DEPARTURE_SQL = `SELECT d.slug, d.tour_slug, d.tour_title, to_char(d.starts_on, 'YYYY-MM-DD') AS starts_on,
    to_char(d.ends_on, 'YYYY-MM-DD') AS ends_on, d.departure_time, d.return_time, d.timezone, d.price_kopecks, d.capacity,
    d.contract, d.contract_complete, d.content, d.booking_status, d.is_demo, d.published_version,
    coalesce((SELECT array_agg(o.organizer_slug ORDER BY o.position) FROM public_departure_organizer o
              WHERE o.departure_slug = d.slug), '{}') AS organizers
  FROM public_departure d`;

function departure(r: DepartureRow): PublicDeparture {
  // Fail-closed: the contract is offered only when the database itself found it complete.
  const contract = r.contract_complete && r.contract?.tour && r.contract.departure
    ? { tour: r.contract.tour, departure: { ...r.contract.departure, departureTime: r.departure_time, returnTime: r.return_time } }
    : null;
  return {
    slug: r.slug, tourSlug: r.tour_slug, tourTitle: r.tour_title, startsOn: r.starts_on, endsOn: r.ends_on,
    bookingStatus: r.booking_status, priceKopecks: r.price_kopecks === null ? null : Number(r.price_kopecks),
    capacity: r.capacity, contract, isListed: true, isDemo: r.is_demo,
    timezone: r.timezone, departureTime: r.departure_time, returnTime: r.return_time, content: r.content,
    publishedVersion: r.published_version, organizers: r.organizers,
  };
}

export async function publicDeparture(pool: pg.Pool | pg.PoolClient, slug: string): Promise<PublicDeparture | null> {
  const { rows } = await pool.query<DepartureRow>(`${DEPARTURE_SQL} WHERE d.slug = $1`, [slug]);
  return rows[0] === undefined ? null : departure(rows[0]);
}

export async function publicDepartures(pool: pg.Pool | pg.PoolClient, tourSlug?: string): Promise<PublicDeparture[]> {
  const { rows } = tourSlug === undefined
    ? await pool.query<DepartureRow>(`${DEPARTURE_SQL} ORDER BY d.starts_on, d.slug`)
    : await pool.query<DepartureRow>(`${DEPARTURE_SQL} WHERE d.tour_slug = $1 ORDER BY d.starts_on, d.slug`, [tourSlug]);
  return rows.map(departure);
}

export async function publicTours(pool: pg.Pool | pg.PoolClient): Promise<PublicTour[]> {
  const { rows } = await pool.query<{ slug: string; title: string; content: PublicTour['content']; published_version: number }>(
    'SELECT slug, title, content, published_version FROM public_tour ORDER BY slug');
  return rows.map((r) => ({ slug: r.slug, title: r.title, content: r.content, publishedVersion: r.published_version }));
}

export async function publicReports(pool: pg.Pool | pg.PoolClient): Promise<PublicReport[]> {
  const { rows } = await pool.query<{ slug: string; title: string; tour_slug: string; departure_slug: string | null;
    date: string | null; noindex: boolean; content: PublicReport['content']; published_version: number }>(
    `SELECT slug, title, tour_slug, departure_slug, to_char(date, 'YYYY-MM-DD') AS date, noindex, content, published_version
       FROM public_report ORDER BY slug`);
  return rows.map((r) => ({ slug: r.slug, title: r.title, tourSlug: r.tour_slug, departureSlug: r.departure_slug, date: r.date,
    noindex: r.noindex, content: r.content, publishedVersion: r.published_version }));
}

export async function publicReviews(pool: pg.Pool | pg.PoolClient): Promise<PublicReview[]> {
  const { rows } = await pool.query<{ slug: string; author_name: string; tour_slug: string | null; is_demo: boolean;
    content: PublicReview['content']; published_version: number }>(
    'SELECT slug, author_name, tour_slug, is_demo, content, published_version FROM public_review ORDER BY slug');
  return rows.map((r) => ({ slug: r.slug, authorName: r.author_name, tourSlug: r.tour_slug, isDemo: r.is_demo,
    content: r.content, publishedVersion: r.published_version }));
}

export async function publicOrganizers(pool: pg.Pool | pg.PoolClient): Promise<PublicOrganizer[]> {
  const { rows } = await pool.query<{ slug: string; name: string; is_demo: boolean; content: PublicOrganizer['content'];
    published_version: number }>('SELECT slug, name, is_demo, content, published_version FROM public_organizer ORDER BY slug');
  return rows.map((r) => ({ slug: r.slug, name: r.name, isDemo: r.is_demo, content: r.content, publishedVersion: r.published_version }));
}


/** One admission adapter for the booking form and the locked reservation transaction. */
export async function bookablePublished(pool: pg.Pool | pg.PoolClient, catalog: Catalog, slug: string,
  now: Date, allowDemo: boolean): Promise<(PublicDeparture & Bookable) | NotBookable> {
  const d=await publicDeparture(pool,slug);
  if (!d) return 'DEPARTURE_UNKNOWN';
  return bookable({...catalog,timezone:d.timezone,departures:new Map([[slug,d]])},slug,now,allowDemo) as (PublicDeparture & Bookable) | NotBookable;
}
