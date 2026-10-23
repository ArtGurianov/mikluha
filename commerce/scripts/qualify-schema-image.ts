// An unchanged, digest-pinned image on schema 12, then an appended additive fixture on schema 13.
// All credentials are disposable; the internal network has no published ports or host mounts.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtureCatalog } from '../test/helpers.js';

const [image, expectedSource] = process.argv.slice(2);
if (!image || !/^[a-f0-9]{40}$/.test(expectedSource ?? '')) throw new Error('usage: qualify-schema-image.ts IMAGE EXPECTED_HEAD_SHA');
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const digest = docker('image', 'inspect', '--format', '{{.Id}}', image);
const suffix = randomBytes(5).toString('hex');
const network = `schema-proof-${suffix}`;
const postgres = `schema-proof-pg-${suffix}`;
const runtime = `schema-proof-runtime-${suffix}`;
const catalog = fixtureCatalog([{ slug: 'proof-departure', startsOn: '2027-06-01', endsOn: '2027-06-04', capacity: 3 }]);
const serialized = JSON.stringify({ ...catalog, departures: [...catalog.departures] });
try {
  docker('network', 'create', '--internal', network);
  docker('run', '-d', '--name', postgres, '--network', network, '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD=isolated-test-only', 'postgres:16-alpine');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', postgres, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ready) throw new Error('disposable PostgreSQL did not start');
  const result = spawnSync('docker', ['run', '--rm', '-i', '--name', runtime, '--network', network,
    '-e', `DATABASE_URL=postgres://postgres:isolated-test-only@${postgres}:5432/postgres`,
    '-e', `QUALIFICATION_CATALOG=${serialized}`, '-e', `QUALIFICATION_SOURCE_COMMIT=${expectedSource}`, digest, 'node', '--input-type=module'], {
    input: readFileSync(fileURLToPath(new URL('./schema-image-probe.mjs', import.meta.url))),
    encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`image qualification failed: ${result.error ?? result.status}`);
  console.log(`SCHEMA_IMAGE_DIGEST=${digest}`);
} finally {
  for (const name of [runtime, postgres]) { try { docker('rm', '-f', name); } catch { /* already removed */ } }
  try { docker('network', 'rm', network); } catch { /* preserve original failure */ }
}
