#!/usr/bin/env node
/**
 * Migrator.
 *
 * Applies `migrations/shard/*.sql` to every shard cluster and `migrations/catalogue/*.sql` to the
 * catalogue. Each file is applied once and its checksum recorded; a file that changed after being
 * applied is a hard error rather than a silent re-run, because in a 64-cluster fleet a silently
 * edited migration means the clusters no longer share a schema.
 *
 *   node packages/db/src/cli/migrate.ts
 *   CIVIC_SHARD_URLS=postgres://... node packages/db/src/cli/migrate.ts
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { loadDbConfig } from '../config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = join(here, '..', '..', 'migrations');

/**
 * The ledger lives in its own `civic_meta` schema, not in `civic_catalogue`: a shard cluster has no
 * catalogue, and the ledger has to exist on every target before anything is applied.
 */
const LEDGER = `
CREATE SCHEMA IF NOT EXISTS civic_meta;
CREATE TABLE IF NOT EXISTS civic_meta.schema_migration (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

async function applyDirectory(connectionString: string, dir: string, label: string) {
  const files = (await readdir(join(migrationsRoot, dir))).filter((f) => f.endsWith('.sql')).sort();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(LEDGER);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM civic_meta.schema_migration',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(migrationsRoot, dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      // Qualified by directory. Without this, `shard/001_init.sql` and `catalogue/001_init.sql`
      // collide whenever both targets are the same database — which is exactly the local setup.
      const ledgerName = `${dir}/${file}`;
      const previous = applied.get(ledgerName);

      if (previous === checksum) {
        console.log(`  · ${label} ${file} already applied`);
        continue;
      }
      if (previous !== undefined) {
        throw new Error(
          `${label} ${ledgerName} was applied with checksum ${previous} but is now ${checksum}. ` +
            'Migrations are immutable once applied — add a new file instead.',
        );
      }

      // One transaction per file: a failure leaves the ledger and the schema consistent.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO civic_meta.schema_migration (name, checksum) VALUES ($1, $2)',
          [ledgerName, checksum],
        );
        await client.query('COMMIT');
        console.log(`  ✓ ${label} ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const config = loadDbConfig();
  console.log(`migrating catalogue and ${config.shardUrls.length} shard cluster(s)`);

  await applyDirectory(config.catalogueUrl, 'catalogue', 'catalogue');
  for (const [i, url] of config.shardUrls.entries()) {
    await applyDirectory(url, 'shard', `shard[${i}]`);
  }
  console.log('migrations complete');
}

await main();
