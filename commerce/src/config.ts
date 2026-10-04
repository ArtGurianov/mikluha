import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** commerce/migrations, from src/ (tsx) or dist/ (built). */
export const MIGRATIONS_DIR = join(here, '..', 'migrations');

export function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`CONFIG_MISSING: ${name}`);
  return v;
}

/**
 * COMMERCE_ENVIRONMENT is STAGING or PRODUCTION. Demo departures are sellable only in STAGING;
 * production also refuses to start from content that is not launchReady.
 */
export function environment(): 'STAGING' | 'PRODUCTION' {
  const v = env('COMMERCE_ENVIRONMENT');
  if (v !== 'STAGING' && v !== 'PRODUCTION') throw new Error('CONFIG_INVALID: COMMERCE_ENVIRONMENT');
  return v;
}

export const PRODUCTION_ADDRESSES = {
  COMMERCE_ORIGIN: 'https://book.mikluha-maklai.ru',
  SITE_ORIGIN: 'https://mikluha-maklai.ru',
  REFREF_API_BASE: 'https://api.refref.ru/v1-rc',
  REFREF_CHECKOUT_ORIGIN: 'https://checkout.refref.ru',
} as const;

export type ProductionAddressName = keyof typeof PRODUCTION_ADDRESSES;

/**
 * Staging addresses remain configurable. Production addresses are trust boundaries: compare their
 * normalized URL representation to the reviewed allowlist, then return the fixed canonical value.
 */
export function productionAddress(
  which: 'STAGING' | 'PRODUCTION',
  name: ProductionAddressName,
  value: string,
): string {
  if (which === 'STAGING') return value;

  let normalized: string;
  try {
    normalized = new URL(value).href;
  } catch {
    throw new Error(`CONFIG_INVALID: ${name}`);
  }

  const expected = PRODUCTION_ADDRESSES[name];
  if (normalized !== new URL(expected).href) {
    throw new Error(`CONFIG_PRODUCTION_ADDRESS_MISMATCH: ${name}`);
  }
  return expected;
}
