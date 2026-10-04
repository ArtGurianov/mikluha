// The HTTP surface of slice 1: health, readiness and identity only. Booking and payment routes come
// with the Refref adapter (ART-47 slice 2) and the booking page (slice 3).

import { createServer, type Server } from 'node:http';

import type pg from 'pg';

import type { Catalog } from './catalog.js';

export const SERVICE = 'mikluha-commerce';

export interface ServerDeps {
  readonly pool: pg.Pool;
  readonly catalog: Catalog;
  readonly schemaHead: number;
  readonly sourceCommit: string | null;
  readonly startedAt: Date;
}

/** READY when the database answers at exactly this build's schema version. */
export async function readiness(deps: ServerDeps): Promise<{ status: 'READY' | 'NOT_READY'; reason?: string; schema?: number }> {
  try {
    const { rows } = await deps.pool.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
    const schema = rows[0]?.v ?? 0;
    if (schema !== deps.schemaHead) return { status: 'NOT_READY', reason: 'SCHEMA_NOT_AT_HEAD', schema };
    return { status: 'READY', schema };
  } catch {
    return { status: 'NOT_READY', reason: 'DATABASE_UNAVAILABLE' };
  }
}

export function createCommerceServer(deps: ServerDeps): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method !== 'GET') { send(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    if (path === '/healthz') { send(200, { ok: true }); return; }
    if (path === '/readyz') {
      readiness(deps).then((r) => send(r.status === 'READY' ? 200 : 503, { service: SERVICE, ...r, sourceCommit: deps.sourceCommit }),
        () => send(503, { service: SERVICE, status: 'NOT_READY' }));
      return;
    }
    if (path === '/identity') {
      send(200, { service: SERVICE, sourceCommit: deps.sourceCommit, schemaHead: deps.schemaHead,
        startedAt: deps.startedAt.toISOString(), termsRef: deps.catalog.terms.ref });
      return;
    }
    send(404, { error: 'NOT_FOUND' });
  });
}
