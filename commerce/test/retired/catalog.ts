// Historical YAML catalog fixture loader. Never part of Commerce src/ or an image.
import { readdirSync, readFileSync, mkdtempSync, cpSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { MIGRATIONS_DIR } from '../../src/config.js';
import { loadSiteRelease, tourContract, departureContract, type Catalog, type Departure } from '../../src/catalog.js';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
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

export function sourceFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'retired-catalog-'));
  const root = join(MIGRATIONS_DIR, '..', '..');
  cpSync(join(root, 'content'), dir, { recursive: true });
  cpSync(join(root, 'test-fixtures/catalog'), dir, { recursive: true });
  return dir;
}
export function loadCatalog(contentDir: string): Catalog {
  const release = loadSiteRelease(contentDir);
  const tours = new Map<string, { title: string; contract: TourContract | null }>();
  for (const f of readdirSync(join(contentDir, 'tours')).filter((x) => x.endsWith('.yml'))) {
    const t = load(join(contentDir, 'tours', f));
    tours.set(str(t, 'slug', f), { title: str(t, 'title', f), contract: tourContract(t.contract) });
  }
  const departures = new Map<string, Departure>();
  for (const f of readdirSync(join(contentDir, 'departures')).filter((x) => x.endsWith('.yml'))) {
    const slug = basename(f, '.yml');
    const d = load(join(contentDir, 'departures', f));
    const tourSlug = str(d, 'tour', slug);
    const tour = tours.get(tourSlug);
    if (tour === undefined) throw new Error(`CATALOG_INVALID: ${slug} names unknown tour ${tourSlug}`);
    const dc = departureContract(d.contract);
    // Whole replacement, never a merge: an incomplete override cannot borrow another trip's facts.
    const rawContract = record(d.contract);
    const product = Object.hasOwn(rawContract, 'product') ? tourContract(rawContract.product) : tour.contract;
    const startsOn = str(d, 'startDate', slug);
    const endsOn = str(d, 'endDate', slug);
    if (!DATE.test(startsOn) || !DATE.test(endsOn) || endsOn < startsOn) throw new Error(`CATALOG_INVALID: ${slug} dates`);
    const status = d.bookingStatus;
    if (status !== 'OPEN' && status !== 'CLOSED' && status !== 'CANCELLED') throw new Error(`CATALOG_INVALID: ${slug} bookingStatus`);
    const price = optInt(d, 'price', slug, 1);
    departures.set(slug, {
      slug, tourSlug, tourTitle: tour.title, startsOn, endsOn, bookingStatus: status,
      priceKopecks: price === null ? null : price * 100,
      capacity: optInt(d, 'capacity', slug, 1),
      contract: product !== null && dc !== null ? { tour: product, departure: dc } : null,
      // Visibility is fail-closed on the site too: only an explicit true.
      isListed: d.isListed === true,
      isDemo: d.isDemo === true,
    });
  }
  return { ...release, departures };
}
