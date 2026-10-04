// The HTTP server: health, readiness and identity here; the customer's routes in web.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type pg from 'pg';

import type { Catalog } from './catalog.js';

export const SERVICE = 'mikluha-commerce';

export interface ServerDeps {
  readonly pool: pg.Pool;
  readonly catalog: Catalog;
  readonly schemaHead: number;
  readonly sourceCommit: string | null;
  readonly startedAt: Date;
  readonly onError?: (e: unknown) => void;
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

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export function createCommerceServer(deps: ServerDeps, routes?: RouteHandler): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') { send(200, { ok: true }); return; }
    if (req.method === 'GET' && path === '/readyz') {
      readiness(deps).then((r) => send(r.status === 'READY' ? 200 : 503, { service: SERVICE, ...r, sourceCommit: deps.sourceCommit }),
        () => send(503, { service: SERVICE, status: 'NOT_READY' }));
      return;
    }
    if (req.method === 'GET' && path === '/identity') {
      send(200, { service: SERVICE, sourceCommit: deps.sourceCommit, schemaHead: deps.schemaHead,
        startedAt: deps.startedAt.toISOString(), termsRef: deps.catalog.terms.ref });
      return;
    }
    if (routes === undefined) { send(404, { error: 'NOT_FOUND' }); return; }
    routes(req, res, url).then((handled) => { if (!handled) send(404, { error: 'NOT_FOUND' }); },
      (e: unknown) => { deps.onError?.(e); send(500, { error: 'INTERNAL' }); });
  });
}
