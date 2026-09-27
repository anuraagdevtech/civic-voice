import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSUMPTIONS,
  computeCapacity,
  crossProductCardinality,
  marginalSavingsFactor,
} from '../src/capacity.ts';
import { maxKeysPerEvent } from '../src/rollup.ts';

/**
 * These assertions pin the figures published in docs/SCALING.md to the constants the runtime
 * actually uses. If someone adds a seventh demographic dimension or a fifth rollup level, this
 * suite fails and names the published number that is now wrong — which is the whole reason the
 * capacity model is code rather than prose.
 */
describe('capacity model matches the published figures', () => {
  const c = computeCapacity();
  const approx = (actual: number, expected: number, tolerance = 0.02) => {
    const drift = Math.abs(actual - expected) / expected;
    assert.ok(
      drift <= tolerance,
      `expected ~${expected.toLocaleString()}, got ${Math.round(actual).toLocaleString()} (${(drift * 100).toFixed(1)}% off)`,
    );
  };

  test('demand: 450M MAU, 90M DAU', () => {
    approx(c.monthlyActive, 450_000_000);
    approx(c.dailyActive, 90_000_000);
  });

  test('throughput: 150M writes/day, 1.5B reads/day', () => {
    approx(c.writesPerDay, 150_000_000);
    approx(c.readsPerDay, 1_500_000_000);
  });

  test('steady state: ~1.7k writes/s, ~17.4k reads/s', () => {
    approx(c.avgWritesPerSecond, 1_700, 0.05);
    approx(c.avgReadsPerSecond, 17_400);
  });

  test('spike: 170k writes/s and 520k reads/s sit inside the 250k/750k provisioned headroom', () => {
    approx(c.spikeWritesPerSecond, 170_000, 0.05);
    approx(c.spikeReadsPerSecond, 520_000);
    assert.ok(c.spikeWritesPerSecond < 250_000, 'write headroom exhausted');
    assert.ok(c.spikeReadsPerSecond < 750_000, 'read headroom exhausted');
  });

  test('the 98% edge hit rate is what keeps origin reads near 10k/s at spike', () => {
    approx(c.originReadsPerSecondAtSpike, 10_450);
    // The load-bearing assumption: losing a point of hit rate roughly doubles origin load.
    const degraded = computeCapacity({ ...ASSUMPTIONS, edgeHitRate: 0.96 });
    assert.ok(degraded.originReadsPerSecondAtSpike > c.originReadsPerSecondAtSpike * 1.9);
  });

  test('rollup fan-out is 28 counters per event, and the model agrees with the code', () => {
    assert.equal(c.rollupKeysPerEvent, 28);
    assert.equal(c.rollupKeysPerEvent, maxKeysPerEvent(), 'model and rollup code must not drift');
    approx(c.rollupIncrementsPerDay, 4_200_000_000);
    approx(c.avgRollupIncrementsPerSecond, 48_000, 0.05);
  });

  test('the counter cluster runs well inside its capacity at spike', () => {
    // Each counter touch is two HINCRBYs, so commands are 2x the touch count. Getting this wrong
    // is exactly how a Redis fleet ends up under-provisioned by 2x.
    approx(c.spikeRollupIncrementsPerSecond, 4_900_000, 0.05);
    assert.equal(c.redisCommandsPerSecondAtSpike, c.spikeRollupIncrementsPerSecond * 2);
    approx(c.redisCommandsPerSecondPerShardAtSpike, 152_000, 0.05);
    assert.ok(
      c.redisUtilisationAtSpike < 0.25,
      `spike utilisation ${(c.redisUtilisationAtSpike * 100).toFixed(1)}% leaves too little headroom`,
    );
  });

  test('halving the shard count would push utilisation past the comfort line', () => {
    // Documents where the cliff is, so 64 reads as a chosen number rather than a round one.
    const halved = computeCapacity({ ...ASSUMPTIONS, redisShards: 32 });
    assert.ok(halved.redisUtilisationAtSpike > 0.25);
  });

  test('the write fleet is ~260 cores / 66 pods at spike, single-digit pods at average', () => {
    approx(c.coresAtSpike, 261, 0.05);
    assert.equal(c.podsAtSpike, 66);
    const avgCores = (c.avgWritesPerSecond * ASSUMPTIONS.cpuMsPerWrite) / 1000;
    assert.ok(Math.ceil(avgCores / ASSUMPTIONS.coresPerPod) <= 3, 'average load should be ~3 pods');
  });

  test('event-log partitions stay comfortably under 1.2 MB/s each', () => {
    assert.ok(c.logMBpsPerPartition < 1.2, `${c.logMBpsPerPartition.toFixed(2)} MB/s per partition`);
  });

  test('marginals are 240x cheaper than the cross-product', () => {
    assert.equal(crossProductCardinality(), 7_200);
    assert.equal(Math.round(marginalSavingsFactor()), 240);
  });
});

describe('capacity model responds to its assumptions', () => {
  test('doubling registered users doubles the derived load', () => {
    const base = computeCapacity();
    const doubled = computeCapacity({ ...ASSUMPTIONS, registeredCitizens: 2.8e9 });
    assert.equal(doubled.writesPerDay / base.writesPerDay, 2);
    assert.equal(doubled.spikeWritesPerSecond / base.spikeWritesPerSecond, 2);
  });

  test('2.8B registered users still fits the provisioned write headroom', () => {
    // Stated so the next person knows how much room is actually left, not just that it fits today.
    const doubled = computeCapacity({ ...ASSUMPTIONS, registeredCitizens: 2.8e9 });
    assert.ok(
      doubled.spikeWritesPerSecond > 250_000,
      'at 2.8B the spike exceeds current headroom — re-provision before that point',
    );
  });
});
