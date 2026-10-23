// The HTTP server: health, readiness and identity here; the customer's routes in web.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type pg from 'pg';

import { MIGRATIONS_DIR } from './config.js';
import { readMigrations, type LockedMigration } from './migration-integrity.js';
import { SchemaAdmission } from './schema-admission.js';
import { schemaReadiness } from './schema-readiness.js';

import type { Catalog } from './catalog.js';
import type { LegalReleaseAdmission } from './legal-admission.js';

export const SERVICE = 'mikluha-commerce';

export interface ServerDeps {
  readonly pool: pg.Pool;
  readonly admission?: SchemaAdmission;
  readonly catalog: Catalog;
  readonly schemaHead: number;
  readonly migrations?: readonly LockedMigration[];
  readonly sourceCommit: string | null;
  readonly startedAt: Date;
  readonly legalAdmission?: LegalReleaseAdmission;
  readonly onError?: (e: unknown) => void;
}

/** READY after immutable prefix and every exact-SHA forward approval, then legal admission. */
export async function readiness(deps: ServerDeps): Promise<{ status: 'READY' | 'NOT_READY'; reason?: string; schema?: number }> {
  try {
    const result = await schemaReadiness(deps.pool, { schemaHead: deps.schemaHead,
      migrations: deps.migrations ?? readMigrations(MIGRATIONS_DIR), sourceCommit: deps.sourceCommit });
    if (result.status !== 'READY') return result;
    const schema = result.schema!;
    if (deps.legalAdmission !== undefined) {
      try { await deps.legalAdmission.verify(); }
      catch { return { status: 'NOT_READY', reason: 'LEGAL_RELEASE_NOT_ADMITTED', schema }; }
    }
    return { status: 'READY', schema };
  } catch {
    return { status: 'NOT_READY', reason: 'DATABASE_UNAVAILABLE' };
  }
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export function createCommerceServer(deps: ServerDeps, routes?: RouteHandler): Server {
  const admission = deps.admission ?? new SchemaAdmission(() => schemaReadiness(deps.pool, {
    schemaHead: deps.schemaHead, migrations: deps.migrations ?? readMigrations(MIGRATIONS_DIR), sourceCommit: deps.sourceCommit,
  }));
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
      admission.status().then(r => r.status === 'READY' ? readiness(deps) : r).then((r) => send(r.status === 'READY' ? 200 : 503, { service: SERVICE, ...r, sourceCommit: deps.sourceCommit }),
        () => send(503, { service: SERVICE, status: 'NOT_READY' }));
      return;
    }
    if (req.method === 'GET' && path === '/identity') {
      send(200, { service: SERVICE, sourceCommit: deps.sourceCommit, schemaHead: deps.schemaHead,
        startedAt: deps.startedAt.toISOString(), termsRef: deps.catalog.terms.ref, termsHash: deps.catalog.terms.hash,
        pdConsentRef: deps.catalog.pdConsent.ref, pdConsentHash: deps.catalog.pdConsent.hash });
      return;
    }
    if (routes === undefined) { send(404, { error: 'NOT_FOUND' }); return; }
    admission.run(async () => {
      if (!await routes(req, res, url)) send(404, { error: 'NOT_FOUND' });
    }).then(r => {
      if (r.status !== 'READY') send(503, { error: 'SCHEMA_NOT_ADMITTED', reason: r.reason });
    }, (e: unknown) => { deps.onError?.(e); send(500, { error: 'INTERNAL' }); });
  });
}
