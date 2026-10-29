// GET /public/v1/catalog: the public projection (public-content.ts) as one document for the SSR site
// (ADR v2.3 §2, TOUR-60). The site renders every page from one such read, so tours, departures and
// what they hang on come from a single READ ONLY snapshot: a publish between two queries can never
// show a departure of a tour the same page no longer lists. Published, listed data only, the same
// rows the checkout prices new quotes from; no credential, no cookie, never cached.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type pg from 'pg';

import {
  publicDepartures, publicOrganizers, publicReports, publicReviews, publicTours,
  type PublicDeparture, type PublicOrganizer, type PublicReport, type PublicReview, type PublicTour,
} from './public-content.js';
import type { RouteHandler } from './server.js';

export const PUBLIC_CATALOG_PATH = '/public/v1/catalog';
export const PUBLIC_CATALOG_SCHEMA = 'mikluha.public-catalog/1';

export interface PublicCatalog {
  readonly schema: typeof PUBLIC_CATALOG_SCHEMA;
  readonly tours: readonly PublicTour[];
  readonly departures: readonly PublicDeparture[];
  readonly organizers: readonly PublicOrganizer[];
  readonly reports: readonly PublicReport[];
  readonly reviews: readonly PublicReview[];
}

export async function readPublicCatalog(pool: pg.Pool): Promise<PublicCatalog> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tours = await publicTours(client);
    const departures = await publicDepartures(client);
    const organizers = await publicOrganizers(client);
    const reports = await publicReports(client);
    const reviews = await publicReviews(client);
    await client.query('COMMIT');
    return { schema: PUBLIC_CATALOG_SCHEMA, tours, departures, organizers, reports, reviews };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex',
};

/** Returns false for every other path, so the customer's routes stay where they are. */
export function createPublicApiHandler(pool: pg.Pool): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== PUBLIC_CATALOG_PATH) return false;
    if (req.method !== 'GET') {
      res.writeHead(405, { ...HEADERS, allow: 'GET' });
      res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
      return true;
    }
    const body = JSON.stringify(await readPublicCatalog(pool));
    res.writeHead(200, HEADERS);
    res.end(body);
    return true;
  };
}
