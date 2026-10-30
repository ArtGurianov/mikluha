// Dedicated media-only login + S3 credentials. No HTTP listener or administrative capability.
import pg from 'pg';
import { env, MIGRATIONS_DIR } from '../config.js';
import { readBuildIdentity, PRODUCTION_BUILD_IDENTITY_FILE } from '../build-identity.js';
import { readMigrations } from '../migration-integrity.js';
import { schemaReadiness } from '../schema-readiness.js';
import { S3MediaStorage } from '../media/storage.js';
import { workOne } from '../media/service.js';
import { jsonLogger } from '../log.js';

if (process.platform !== 'linux') throw new Error('MEDIA_LINUX_REQUIRED');
for (const key of [
  'DATABASE_URL',
  'ADMIN_DATABASE_URL',
  'ADMIN_PUBLISH_DATABASE_URL',
  'OPERATOR_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'REFREF_API_KEY',
  'NOTISEND_API_KEY',
  'GITHUB_TOKEN',
  'ADMIN_TOTP_KEY',
  'ADMIN_AUDIT_KEY',
]) {
  if (process.env[key]) throw new Error('MEDIA_FOREIGN_CREDENTIAL');
}
const log = jsonLogger('mikluha-media-worker');
const pool = new pg.Pool({
  connectionString: env('MEDIA_DATABASE_URL'),
  max: 1,
  connectionTimeoutMillis: 5000,
});
const role = (
  await pool.query(`SELECT session_user=current_user AND pg_has_role(current_user,'media_worker','MEMBER')
  AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['commerce_app','commerce_operator','admin_app','admin_publisher','admin_operator']) r
    WHERE pg_has_role(current_user,r,'MEMBER')) AS isolated FROM pg_roles WHERE rolname=current_user`)
).rows[0];
if (role?.isolated !== true) throw new Error('MEDIA_LOGIN_NOT_ISOLATED');
const identity = await readBuildIdentity(PRODUCTION_BUILD_IDENTITY_FILE);
const migrations = readMigrations(MIGRATIONS_DIR);
const storage = new S3MediaStorage({
  endpoint: env('MEDIA_S3_ENDPOINT'),
  bucket: env('MEDIA_S3_BUCKET'),
  publicOrigin: env('MEDIA_S3_PUBLIC_ORIGIN'),
  principalArn: env('MEDIA_S3_PRINCIPAL_ARN'),
  region: env('MEDIA_S3_REGION'),
  accessKeyId: env('MEDIA_S3_ACCESS_KEY_ID'),
  secretAccessKey: env('MEDIA_S3_SECRET_ACCESS_KEY'),
});
await storage.assertConfiguration();
let stopping = false;
process.once('SIGTERM', () => {
  stopping = true;
});
process.once('SIGINT', () => {
  stopping = true;
});
while (!stopping) {
  try {
    const ready = await schemaReadiness(pool, {
      schemaHead: migrations.length,
      migrations,
      sourceCommit: identity.sourceCommit,
    });
    if (ready.status !== 'READY') {
      log('schema_not_admitted');
    } else if (await workOne(pool, storage)) continue;
  } catch {
    log('media_work_failed');
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
await pool.end();
