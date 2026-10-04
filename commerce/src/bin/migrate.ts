// Apply schema migrations as the database OWNER: MIGRATION_DATABASE_URL, never the runtime role.
import pg from 'pg';

import { env, MIGRATIONS_DIR } from '../config.js';
import { migrate } from '../migrate.js';

const client = new pg.Client({ connectionString: env('MIGRATION_DATABASE_URL') });
await client.connect();
try {
  const applied = await migrate(client, MIGRATIONS_DIR);
  console.log(applied.length === 0 ? 'MIGRATE=UP_TO_DATE' : `MIGRATE=APPLIED ${applied.join(',')}`);
} finally {
  await client.end();
}
