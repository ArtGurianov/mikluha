// TOUR-78 / MK-POLICY-v2.4: the canonical catalog zone is Asia/Krasnoyarsk. The retired Sveltia
// config carried a Europe/Moscow default; these checks keep every remaining default aligned and
// make an invalid site timezone a refusal rather than a silent substitution.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

import { ianaTimezone, loadSiteRelease } from '../src/catalog.js';
import { initialDocument } from '../../control-room/lib/editorial.js';
import { sourceFixtureDir } from './retired/catalog.js';

const CANONICAL = 'Asia/Krasnoyarsk';
const repo = fileURLToPath(new URL('../../', import.meta.url));

test('the repository site setting is the canonical, valid IANA zone', () => {
  const settings = yaml.load(readFileSync(join(repo, 'content', 'site-settings.yml'), 'utf8'), { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
  assert.equal(settings.timezone, CANONICAL);
  assert.equal(ianaTimezone(settings.timezone as string, 'site-settings'), CANONICAL);
});

test('a new Control Room departure defaults to the canonical site zone, not Europe/Moscow', () => {
  const doc = initialDocument('departures', { id: 'x', slug: 'trip', publishedVersion: null, draftRevision: null });
  assert.equal(doc.timezone, CANONICAL);
});

test('the retired Sveltia CMS configuration cannot reintroduce its Moscow default', () => {
  assert.throws(() => readFileSync(join(repo, 'public', 'admin', 'config.yml')), { code: 'ENOENT' });
});

test('invalid or mis-spelled site timezones stop the catalog; nothing is substituted', () => {
  for (const bad of ['Mars/Olympus', 'asia/krasnoyarsk', 'ASIA/KRASNOYARSK', 'Asia/krasnoyarsk', 'Asia/Krasnoyarsk ', ' Asia/Krasnoyarsk',
    'UTC', '+07:00', 'Krasnoyarsk', 'europe/kyiv', 'Europe/KYIV', 'Asia/Krasnoyarsk/', '/Asia/Krasnoyarsk', '']) {
    assert.throws(() => ianaTimezone(bad, 'site-settings'), /CATALOG_INVALID: site-settings timezone/, JSON.stringify(bad));
  }
});

test('valid IANA names are preserved as written, including current names ICU reports under older aliases', () => {
  // Review of PR #69: Node 22 ICU resolves Europe/Kyiv to Europe/Kiev and Asia/Kolkata to Asia/Calcutta.
  // These are valid explicit settings and must not stop Commerce. CI and the commerce image both run
  // Node 22 (node:22-alpine); a future ICU that stopped accepting one of them fails here first.
  for (const good of [CANONICAL, 'Europe/Moscow', 'Asia/Novosibirsk', 'Europe/Kyiv', 'Europe/Kiev', 'Asia/Kolkata', 'Asia/Calcutta',
    'America/Nuuk', 'Asia/Ho_Chi_Minh', 'America/Argentina/Buenos_Aires', 'America/Port-au-Prince', 'Antarctica/DumontDUrville', 'Etc/GMT+5']) {
    assert.equal(ianaTimezone(good, 'site-settings'), good, good);
  }
});

test('loadSiteRelease preserves an explicit valid zone and refuses an invalid one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'commerce-tz-'));
  cpSync(sourceFixtureDir(), dir, { recursive: true });
  const path = join(dir, 'site-settings.yml');
  const original = yaml.load(readFileSync(path, 'utf8'), { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
  for (const explicit of [CANONICAL, 'Asia/Novosibirsk', 'Europe/Kyiv']) {
    writeFileSync(path, yaml.dump({ ...original, timezone: explicit }));
    assert.equal(loadSiteRelease(dir).timezone, explicit);
  }
  for (const bad of ['Mars/Olympus', 'europe/moscow', '']) {
    writeFileSync(path, yaml.dump({ ...original, timezone: bad }));
    assert.throws(() => loadSiteRelease(dir), /CATALOG_INVALID: site-settings/, bad);
  }
});
