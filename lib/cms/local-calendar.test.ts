import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { LOCAL_TIME_ZONE, localCalendarDate } from '../../control-room/lib/local-calendar';

test('SQL and public SSR consume the shared new-publication calendar', () => {
  const read = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
  const sql = read('commerce/migrations/0020_krasnoyarsk_local_calendar.sql');
  assert.equal(sql.match(/AS \$\$ SELECT \(p_at AT TIME ZONE '([^']+)'\)::date \$\$/)?.[1], LOCAL_TIME_ZONE);
  assert.match(sql, /LANGUAGE sql STABLE STRICT/);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM legal_publication\)/);
  assert.doesNotMatch(sql, /calendar_timezone/);
  assert.match(sql, /p_effective < fn_local_calendar_date\(clock_timestamp\(\)\)/);
  for (const alias of ['p', 'q']) assert.ok(sql.includes(`${alias}.effective_on <= fn_local_calendar_date(clock_timestamp())`));
  const ssr = read('lib/cms/legal-projection.ts');
  assert.match(ssr, /import \{ localCalendarDate \} from "\.\.\/\.\.\/control-room\/lib\/local-calendar"/);
  assert.match(ssr, /const today = localCalendarDate\(now\)/);
  assert.doesNotMatch(ssr, /timeZone\s*:/, 'SSR must not introduce a separate timezone default');
});

test('canonical local day changes at 17:00 UTC, including year transition', () => {
  assert.equal(localCalendarDate(new Date('2026-11-01T16:59:59.999Z')), '2026-11-01');
  assert.equal(localCalendarDate(new Date('2026-11-01T17:00:00Z')), '2026-11-02');
  assert.equal(localCalendarDate(new Date('2026-12-31T17:00:00Z')), '2027-01-01');
});
