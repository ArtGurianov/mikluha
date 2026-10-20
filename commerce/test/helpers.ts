// A fresh database per test file, migrated by the owner, used by a login that is only a member of
// commerce_app (the service), one that is only a member of commerce_operator, one that is only a
// member of admin_app (the Admin API) and one that is only a member of admin_operator, as in production. TEST_DATABASE_URL is a superuser on a disposable server.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import { loadCatalog, type Catalog } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import type { Logger } from '../src/log.js';
import type { TouristInput } from '../src/orders.js';
import { migrate } from '../src/migrate.js';

const ADMIN = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55432/postgres';
const RUNTIME_ROLE = 'commerce_test_runtime';
const OPERATOR_ROLE = 'commerce_test_operator';
const ADMIN_ROLE = 'commerce_test_admin';
const PUBLISHER_ROLE = 'commerce_test_admin_publisher';
const ADMIN_OPERATOR_ROLE = 'commerce_test_admin_operator';
const PASSWORD = 'commerce-test-only';

export interface TestDb {
  readonly owner: pg.Client;
  /** The service's login (commerce_app). */
  readonly pool: pg.Pool;
  /** An operator's login (commerce_operator). */
  readonly operator: pg.Pool;
  /** The Admin API's login (admin_app). */
  readonly admin: pg.Pool;
  readonly publisher: pg.Pool;
  /** An admin operator's login (admin_operator), as over SSH. */
  readonly adminOperator: pg.Pool;
  readonly url: URL;
  readonly name: string;
  drop(timeoutMs?: number): Promise<void>;
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
  for (const [login, role] of [[RUNTIME_ROLE, 'commerce_app'], [OPERATOR_ROLE, 'commerce_operator'], [ADMIN_ROLE, 'admin_app'],
    [ADMIN_OPERATOR_ROLE, 'admin_operator'], [PUBLISHER_ROLE, 'admin_publisher']]) {
    await owner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN
        CREATE ROLE ${login} LOGIN PASSWORD '${PASSWORD}' IN ROLE ${role};
      END IF; END $$`);
  }
  const clientClosures: Promise<void>[] = [];
  const as = (login: string, max: number) => {
    const u = new URL(url);
    u.username = login;
    u.password = PASSWORD;
    const pool = new pg.Pool({ connectionString: u.toString(), max });
    pool.on('connect', client => {
      clientClosures.push(new Promise<void>(resolve => { client.once('end', resolve); }));
    });
    return pool;
  };
  const pool = as(RUNTIME_ROLE, 12);
  const operator = as(OPERATOR_ROLE, 2);
  const adminPool = as(ADMIN_ROLE, 4);
  const publisher = as(PUBLISHER_ROLE, 4);
  const adminOperator = as(ADMIN_OPERATOR_ROLE, 2);
  let teardown: Promise<void> | undefined;
  return {
    owner, pool, operator, admin: adminPool, adminOperator, publisher, url, name,
    async drop(timeoutMs = 10_000) {
      // Reuse cleanup after a bounded diagnostic failure, so a test can release its leaked
      // client and await the same operation instead of ending a pool twice.
      teardown ??= (async () => {
        try {
          await Promise.all([pool.end(), operator.end(), adminPool.end(), adminOperator.end(), publisher.end()]);
          // pg-pool removes clients before their socket-end callbacks finish.
          await Promise.all(clientClosures);
          await owner.end();
          await admin.query(`DROP DATABASE ${name}`);
        } finally { await admin.end(); }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([teardown, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const counts = [["runtime", pool], ["operator", operator], ["admin", adminPool]] as const;
            const detail = counts.map(([label, p]) => `${label}: checkedOut=${p.totalCount - p.idleCount}, waiting=${p.waitingCount}`).join("; ");
            reject(new Error(`TEST_DATABASE_TEARDOWN_TIMEOUT ${name} after ${timeoutMs}ms (${detail}); release checked-out clients and await drop() again`));
          }, timeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}

export interface FixtureDeparture {
  slug: string; startsOn: string; endsOn?: string; status?: string; price?: number | null; capacity?: number | null;
  isListed?: boolean; isDemo?: boolean;
  /** false: the departure has no contract data, so it cannot be sold. */
  contract?: boolean;
}

const TOUR_CONTRACT = `contract:
  destination: Республика Алтай
  route: Кемерово — Телецкое озеро — Кемерово
  program:
    - title: "День 1. Кемерово — Телецкое озеро"
      items: |-
        06:00 — отправление
        Заселение, ужин
    - title: "День 2. Озеро"
      items: |-
        Прогулка на теплоходе
  included: |-
    Проезд
    Проживание
  excluded: Обеды
  risks: Горная местность, перепады погоды
`;

const DEPARTURE_CONTRACT = `contract:
  departureTime: "06:00"
  returnTime: "21:00"
  departurePoint: Кемерово, пл. Советов, 06:00
  returnPoint: Кемерово, пл. Советов, около 21:00
  accommodation:
    name: Гостевой дом «Озеро»
    address: Республика Алтай, с. Артыбаш
    roomType: 2-местный номер
    nights: 3
    meals: Завтраки
    legalEntity: ИП Озёрный
  carrier:
    legalName: ООО «Перевозчик»
    route: Кемерово — Артыбаш — Кемерово
    baggage: 1 место багажа
    boarding: по документу, за 20 минут
  services:
    - name: Теплоход
      supplier: ИП Озёрный
      included: true
`;

export const TERMS_TEXT = '## Оферта\n\nТестовая публичная оферта.';
export const PD_CONSENT_TEXT = '## Согласие на обработку персональных данных\n\nТестовая версия согласия.';

/** A valid adult Russian tourist; `n` varies the name and the passport. */
export const tourist = (n = 1, over: Partial<TouristInput> = {}): TouristInput => ({
  fullName: ['Иван Петров', 'Анна Петрова', 'Олег Сидоров', 'Мария Сидорова'][(n - 1) % 4]!,
  dateOfBirth: '1990-05-17', citizenship: 'RU',
  document: { type: 'RU_PASSPORT', series: '3210', number: String(654320 + n) }, ...over,
});

export function fixtureCatalog(departures: FixtureDeparture[]): Catalog {
  const dir = mkdtempSync(join(tmpdir(), 'commerce-content-'));
  for (const sub of ['tours', 'departures', 'legal']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, 'site-settings.yml'), 'timezone: Asia/Krasnoyarsk\nlaunchReady: true\n');
  writeFileSync(join(dir, 'tours', 'altai.yml'), `title: Алтай\nslug: altai\n${TOUR_CONTRACT}`);
  writeFileSync(join(dir, 'legal', 'oferta.yml'),
    `title: Публичная оферта\nslug: oferta\nrefundPolicy: FULL_ONLY\nupdatedAt: "2026-10-04"\ncontent: |-\n${TERMS_TEXT.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
  writeFileSync(join(dir, 'legal', 'soglasie-pd.yml'),
    `title: Согласие на обработку персональных данных\nslug: soglasie-pd\nupdatedAt: "2026-10-04"\ncontent: |-\n${PD_CONSENT_TEXT.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
  for (const d of departures) {
    // Dates unquoted, as the CMS writes them.
    const lines = [`tour: altai`, `startDate: ${d.startsOn}`, `endDate: ${d.endsOn ?? d.startsOn}`,
      `bookingStatus: ${d.status ?? 'OPEN'}`];
    if (d.price !== null) lines.push(`price: ${d.price ?? 34000}`);
    if (d.capacity !== null) lines.push(`capacity: ${d.capacity ?? 12}`);
    lines.push(`isListed: ${d.isListed ?? true}`, `isDemo: ${d.isDemo ?? false}`);
    writeFileSync(join(dir, 'departures', `${d.slug}.yml`), `${lines.join('\n')}\n${d.contract === false ? '' : DEPARTURE_CONTRACT}`);
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
