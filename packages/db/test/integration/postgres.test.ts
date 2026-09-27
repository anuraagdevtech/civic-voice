import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { uuidv7 } from '@civic-voice/core';
import { loadDbConfig, shardMapFrom } from '../../src/config.ts';
import { ShardRouter } from '../../src/router.ts';
import { createPgRepositories } from '../../src/repositories/postgres.ts';
import { forEachShardCluster, vshardBucket } from '../../src/maintenance.ts';
import { runRepositoryContract } from '../repositories.contract.ts';

/**
 * The Postgres half of the repository conformance suite, plus the behaviour that only exists against
 * a real engine. Skipped when no database is reachable, so `pnpm test` stays daemon-free; CI runs it.
 */
const config = loadDbConfig();

const reachable = await (async () => {
  const client = new Client({
    connectionString: config.catalogueUrl,
    connectionTimeoutMillis: 1_500,
  });
  try {
    await client.connect();
    await client.query('SELECT 1 FROM civic_shard.citizen LIMIT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
})();

const openRepositories = async () => {
  const router = new ShardRouter({
    shardMap: shardMapFrom(config),
    catalogueConnectionString: config.catalogueUrl,
  });
  const repos = createPgRepositories(router);
  await repos.ready();
  return repos;
};

if (!reachable) {
  describe('repository contract: postgres', () => {
    test('skipped — no migrated Postgres reachable (run pnpm migrate)', (t) => t.skip());
  });
} else {
  runRepositoryContract('postgres', openRepositories);

  describe('postgres-specific behaviour', () => {
    test('a citizen is stored on the vshard the router computes, not somewhere else', async () => {
      // A shard map that disagrees with the data is how writes land on the wrong shard and quietly
      // disappear. Asserting the stored vshard matches the routing function closes that gap.
      const router = new ShardRouter({
        shardMap: shardMapFrom(config),
        catalogueConnectionString: config.catalogueUrl,
      });
      const repos = createPgRepositories(router);
      try {
        const id = uuidv7();
        await repos.citizens.create({
          id,
          region_id: 1052,
          region_path: [1, 10, 105, 1052],
          locale: 'en',
          demographics: {},
        });
        const stored = await router.withCitizenShard(id, async (db) => {
          const { rows } = await db.query<{ vshard: number }>(
            'SELECT vshard FROM civic_shard.citizen WHERE id = $1',
            [id],
          );
          return Number(rows[0]?.vshard);
        });
        assert.equal(stored, router.vshardOf(id));
      } finally {
        await repos.close();
      }
    });

    test('concurrent upserts for one citizen serialise, so only one sees each previous value', async () => {
      // `FOR UPDATE` in the CTE is what makes this true. Without it, two concurrent events could both
      // read the same `previous` and both emit the same compensating −1, over-subtracting the bucket.
      const repos = await openRepositories();
      try {
        const id = uuidv7();
        await repos.citizens.create({
          id,
          region_id: 1052,
          region_path: [1, 10, 105, 1052],
          locale: 'en',
          demographics: {},
        });
        await repos.sentiment.upsert(id, {
          topic_id: 1,
          mood: -2,
          intensity: 5,
          reason_code: 'no_reason',
          event_id: uuidv7(),
        });

        const results = await Promise.all([
          repos.sentiment.upsert(id, {
            topic_id: 1,
            mood: 1,
            intensity: 3,
            reason_code: 'no_reason',
            event_id: uuidv7(),
          }),
          repos.sentiment.upsert(id, {
            topic_id: 1,
            mood: 2,
            intensity: 4,
            reason_code: 'no_reason',
            event_id: uuidv7(),
          }),
        ]);

        const sawOriginal = results.filter((r) => r.previous?.mood === -2);
        assert.equal(sawOriginal.length, 1, 'exactly one writer may claim the original value');
        assert.ok(results.every((r) => r.applied));
      } finally {
        await repos.close();
      }
    });

    test('the catalogue resolves topics by jurisdiction path, not by exact region', async () => {
      const repos = await openRepositories();
      try {
        // A constituency in Uttar Pradesh should see national, state and its own topics.
        const region = await repos.catalogue.getRegion(1);
        assert.ok(region, 'seed data must be present (pnpm seed)');

        const up = (await repos.catalogue.childRegions(1)).find((r) => r.name === 'Uttar Pradesh');
        assert.ok(up, 'expected Uttar Pradesh in the seed');
        const lucknow = (await repos.catalogue.childRegions(up.id)).find(
          (r) => r.name === 'Lucknow',
        );
        assert.ok(lucknow);
        const cantt = (await repos.catalogue.childRegions(lucknow.id))[0];
        assert.ok(cantt);

        const applicable = await repos.catalogue.listTopics({ regionId: cantt.id });
        const jurisdictions = new Set(applicable.map((t) => t.jurisdiction_region_id));
        assert.ok(jurisdictions.has(1), 'national topics apply');
        assert.ok(jurisdictions.has(up.id), 'state topics apply');
        // And a topic from another state must not.
        const kerala = (await repos.catalogue.childRegions(1)).find((r) => r.name === 'Kerala');
        assert.ok(kerala);
        assert.equal(jurisdictions.has(kerala.id), false, 'another state’s topics must not apply');
      } finally {
        await repos.close();
      }
    });

    test('budget lines carry provenance and never report spending more than was released', async () => {
      const repos = await openRepositories();
      try {
        const up = (await repos.catalogue.childRegions(1)).find((r) => r.name === 'Uttar Pradesh');
        assert.ok(up);
        const lines = await repos.catalogue.budgetLines(up.id, '2026-27');
        assert.ok(lines.length > 0, 'seed data must be present');
        for (const line of lines) {
          assert.ok(line.source_refs.length > 0, `${line.scheme_name} has no source`);
          assert.ok(
            (line.utilised ?? 0) <= (line.released ?? 0),
            `${line.scheme_name} reports utilising more than was released`,
          );
        }
      } finally {
        await repos.close();
      }
    });

    test('maintenance access reaches every cluster, and is bounded', async () => {
      const router = new ShardRouter({
        shardMap: shardMapFrom(config),
        catalogueConnectionString: config.catalogueUrl,
      });
      try {
        const visited = await forEachShardCluster(router, async ({ clusterId, db }) => {
          await db.query('SELECT 1');
          return clusterId;
        });
        assert.equal(visited.length, router.shardMap.allClusters().length);
      } finally {
        await router.close();
      }
    });

    test('the sweeper’s vshard buckets tile the whole range exactly once', async () => {
      const covered = new Set<number>();
      for (let tick = 0; tick < 24; tick += 1) {
        const { from, to } = vshardBucket(tick, 24);
        for (let v = from; v < to; v += 1) {
          assert.equal(covered.has(v), false, `vshard ${v} swept twice in one cycle`);
          covered.add(v);
        }
      }
      assert.equal(covered.size, 1024, 'a full cycle must cover every vshard');
    });
  });
}
