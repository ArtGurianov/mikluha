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
