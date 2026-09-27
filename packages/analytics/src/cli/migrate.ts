#!/usr/bin/env node
/**
 * ClickHouse migrator. Statements are split on `;` at the top level and applied in order; the
 * schema is written with `IF NOT EXISTS` throughout, so re-running is a no-op.
 *
 *   node packages/analytics/src/cli/migrate.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@clickhouse/client';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');

const client = createClient({
  url: process.env['CLICKHOUSE_URL'] ?? 'http://127.0.0.1:8123',
  username: process.env['CLICKHOUSE_USER'] ?? 'civic',
  password: process.env['CLICKHOUSE_PASSWORD'] ?? 'civic',
});

/** Split on semicolons, ignoring those inside string literals or line comments. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let inComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (inComment) {
      if (ch === '\n') inComment = false;
      current += ch;
      continue;
    }
    if (!inString && ch === '-' && next === '-') {
      inComment = true;
      current += ch;
      continue;
    }
    if (ch === "'" && sql[i - 1] !== '\\') inString = !inString;
    if (ch === ';' && !inString) {
      statements.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  statements.push(current);

  return statements
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
for (const file of files) {
  const sql = await readFile(join(migrationsDir, file), 'utf8');
  const statements = splitStatements(sql);
  for (const [i, statement] of statements.entries()) {
    try {
      await client.command({ query: statement });
    } catch (err) {
      console.error(`✗ ${file} statement ${i + 1}:\n${statement.slice(0, 300)}`);
      throw err;
    }
  }
  console.log(`  ✓ ${file} (${statements.length} statements)`);
}
await client.close();
console.log('clickhouse migrations complete');
