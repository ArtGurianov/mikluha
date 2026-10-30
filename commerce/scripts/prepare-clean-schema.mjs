// TOUR-57: no supplied database URL, host mount or published port. Only this invocation's resources
// are removed. The SQL export is for review; installation always replays the append-only journal.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [image, expectedSource, output, ...extra] = process.argv.slice(2);
if (!image || !/^[a-f0-9]{40}$/.test(expectedSource ?? '') || !output || extra.length) {
  throw new Error('usage: node scripts/prepare-clean-schema.mjs IMAGE EXPECTED_HEAD_SHA NEW_OUTPUT_DIR');
}
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
const commerceImage = docker('image', 'inspect', '--format', '{{.Id}}', image).trim();
const postgresImage = docker('image', 'inspect', '--format', '{{.Id}}', 'postgres:16-alpine').trim();
const suffix = randomBytes(8).toString('hex');
const network = `tour57-schema-${suffix}`;
const postgres = `tour57-pg-${suffix}`;
const runtime = `tour57-probe-${suffix}`;
let networkCreated = false;
let postgresCreated = false;
let runtimeStarted = false;
let completed;
try {
  docker('network', 'create', '--internal', network); networkCreated = true;
  docker('run', '-d', '--name', postgres, '--network', network, '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD=disposable-schema-only', postgresImage); postgresCreated = true;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', postgres, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore', timeout: 5000 }).status === 0) { ready = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ready) throw new Error('DISPOSABLE_POSTGRES_NOT_READY');
  runtimeStarted = true;
  const probeSource = readFileSync(fileURLToPath(new URL('./clean-schema-probe.mjs', import.meta.url)));
  const probe = execFileSync('docker', ['run', '--rm', '-i', '--name', runtime, '--network', network,
    '-e', `MIGRATION_DATABASE_URL=postgres://postgres:disposable-schema-only@${postgres}:5432/postgres`,
    '-e', `EXPECTED_SOURCE_COMMIT=${expectedSource}`, commerceImage, 'node', '--input-type=module'], {
    input: probeSource,
    encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(probe);
  const schema = docker('exec', postgres, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--no-password');
  const dir = resolve(output);
  // Refuse to overwrite an earlier receipt. The manifest is written last, only after every check.
  mkdirSync(dir);
  writeFileSync(join(dir, 'schema.sql'), schema, { flag: 'wx' });
  const manifest = { format: 1, task: 'TOUR-57', scope: 'disposable clean-schema qualification; not installation or recovery evidence',
    createdAt: new Date().toISOString(), commerceImage, postgresImage, ...report,
    preparationScriptSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    probeSha256: createHash('sha256').update(probeSource).digest('hex'),
    schemaSqlSha256: createHash('sha256').update(schema).digest('hex') };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  completed = `CLEAN_SCHEMA=PASS head=${report.schemaHead} manifest=${join(dir, 'manifest.json')}`;
} finally {
  const failures = [];
  for (const [created, name] of [[runtimeStarted, runtime], [postgresCreated, postgres]]) {
    if (created && spawnSync('docker', ['container', 'inspect', name], { stdio: 'ignore' }).status === 0) {
      try { docker('rm', '-f', name); } catch { failures.push(name); }
    }
  }
  if (networkCreated) { try { docker('network', 'rm', network); } catch { failures.push(network); } }
  if (failures.length) throw new Error(`DISPOSABLE_CLEANUP_FAILED: ${failures.join(',')}`);
}
console.log(completed);
