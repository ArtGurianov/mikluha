// A fresh database per test file, migrated by the owner, used by a login that is only a member of
// commerce_app (the service) and one that is only a member of commerce_operator, as in production. TEST_DATABASE_URL is a superuser on a disposable server.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import { loadCatalog, type Catalog } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import type { Logger } from '../src/log.js';
import { migrate } from '../src/migrate.js';

const ADMIN = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55432/postgres';
const RUNTIME_ROLE = 'commerce_test_runtime';
const OPERATOR_ROLE = 'commerce_test_operator';
const PASSWORD = 'commerce-test-only';

export interface TestDb {
  readonly owner: pg.Client;
  /** The service's login (commerce_app). */
  readonly pool: pg.Pool;
  /** An operator's login (commerce_operator). */
  readonly operator: pg.Pool;
  readonly url: URL;
  readonly name: string;
  drop(): Promise<void>;
}

export async function freshDb(): Promise<TestDb> {
  const name = `commerce_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN);
  url.pathname = `/${name}`;
  const owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
  await migrate(owner, MIGRATIONS_DIR);
  for (const [login, role] of [[RUNTIME_ROLE, 'commerce_app'], [OPERATOR_ROLE, 'commerce_operator']]) {
    await owner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN
        CREATE ROLE ${login} LOGIN PASSWORD '${PASSWORD}' IN ROLE ${role};
      END IF; END $$`);
  }
  const as = (login: string, max: number) => {
    const u = new URL(url);
    u.username = login;
    u.password = PASSWORD;
    return new pg.Pool({ connectionString: u.toString(), max });
  };
  const pool = as(RUNTIME_ROLE, 12);
  const operator = as(OPERATOR_ROLE, 2);
  return {
    owner, pool, operator, url, name,
    async drop() {
      await pool.end();
      await operator.end();
      await owner.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export interface FixtureDeparture {
  slug: string; startsOn: string; endsOn?: string; status?: string; price?: number | null; capacity?: number | null;
  requiresDateOfBirth?: boolean; isListed?: boolean; isDemo?: boolean;
}

export const TERMS_TEXT = '## Условия\n\nТестовые условия бронирования.';

export function fixtureCatalog(departures: FixtureDeparture[]): Catalog {
  const dir = mkdtempSync(join(tmpdir(), 'commerce-content-'));
  for (const sub of ['tours', 'departures', 'legal']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, 'site-settings.yml'), 'timezone: Asia/Krasnoyarsk\nlaunchReady: true\n');
  writeFileSync(join(dir, 'tours', 'altai.yml'), 'title: Алтай\nslug: altai\n');
  writeFileSync(join(dir, 'legal', 'booking-terms.yml'),
    `title: Условия\nslug: booking-terms\nupdatedAt: "2026-10-04"\ncontent: |-\n${TERMS_TEXT.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
  for (const d of departures) {
    // Dates unquoted, as the CMS writes them.
    const lines = [`tour: altai`, `startDate: ${d.startsOn}`, `endDate: ${d.endsOn ?? d.startsOn}`,
      `bookingStatus: ${d.status ?? 'OPEN'}`];
    if (d.price !== null) lines.push(`price: ${d.price ?? 34000}`);
    if (d.capacity !== null) lines.push(`capacity: ${d.capacity ?? 12}`);
    if (d.requiresDateOfBirth) lines.push('requiresDateOfBirth: true');
    lines.push(`isListed: ${d.isListed ?? true}`, `isDemo: ${d.isDemo ?? false}`);
    writeFileSync(join(dir, 'departures', `${d.slug}.yml`), `${lines.join('\n')}\n`);
  }
  return loadCatalog(dir);
}

export function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (event, fields = {}) => { lines.push(JSON.stringify({ event, ...fields })); } };
}

/**
 * Move an order to a later state directly, with the columns that state requires (migration 0002's
 * constraints), for tests about what happens AFTER checkout (seats, erasure).
 */
export async function forceStatus(owner: pg.Client, orderRef: string, status: 'PAYMENT_PENDING' | 'FULFILLED', extra = ''): Promise<void> {
  const frozen = `snapshot = '{}', snapshot_hash = 'refref-jcs-1:${'0'.repeat(64)}', payment_pending_since = now()`;
  const paid = status === 'FULFILLED' ? `, payment_id = gen_random_uuid(), paid_at = now(), fulfilled_at = now()` : '';
  await owner.query(`UPDATE orders SET status = $2, ${frozen}${paid}${extra} WHERE order_ref = $1`, [orderRef, status]);
}
