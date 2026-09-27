import { DEMOGRAPHIC_DIMENSIONS, ROLLUP_FANOUT } from '@civic-voice/contracts';

/**
 * The capacity model from docs/SCALING.md, as executable code.
 *
 * Capacity numbers written only in prose rot silently: someone adds a seventh demographic
 * dimension or a fifth rollup level, the doc still says 28 counters per event, and the Redis
 * cluster is under-provisioned by 40% before anyone notices. Here the numbers are *derived* from
 * the same constants the runtime uses, and the test suite asserts the documented figures. Change a
 * constant and the test tells you which published number is now wrong.
 */

/**
 * Declared as an interface rather than inferred from `as const`, so a caller can re-run the model
 * with one assumption changed — which is exactly how the sensitivity checks in the tests work, and
 * how a capacity review is meant to be conducted.
 */
export interface CapacityAssumptions {
  registeredCitizens: number;
  monthlyActiveShare: number;
  dailyActiveShareOfMonthly: number;
  sessionsPerDailyActive: number;
  sentimentWritesPerSession: number;
  aggregateReadsPerSession: number;
  diurnalPeakMultiplier: number;
  eventSpikeMultiplier: number;
  readSpikeMultiplier: number;
  edgeHitRate: number;
  cpuMsPerWrite: number;
  coresPerPod: number;
  bytesPerEvent: number;
  logReplicationFactor: number;
  logPartitions: number;
  redisCommandsPerKeyTouch: number;
  redisOpsPerSecondPerShard: number;
  redisShards: number;
  secondsPerDay: number;
}

export const ASSUMPTIONS: CapacityAssumptions = {
  registeredCitizens: 1_400_000_000,
  monthlyActiveShare: 0.32,
  dailyActiveShareOfMonthly: 0.2,
  sessionsPerDailyActive: 1.4,
  sentimentWritesPerSession: 1.2,
  aggregateReadsPerSession: 12,

  /** Civic attention is peaky: a budget speech or a verdict moves the whole country at once. */
  diurnalPeakMultiplier: 3,
  eventSpikeMultiplier: 100,
  readSpikeMultiplier: 30,

  /** Fraction of aggregate reads that terminate at the CDN. The load-bearing assumption. */
  edgeHitRate: 0.98,

  /** Measured per-write service time: one Redis pipeline plus one batched log append. */
  cpuMsPerWrite: 1.5,
  coresPerPod: 4,

  bytesPerEvent: 400,
  logReplicationFactor: 3,
  logPartitions: 256,

  /**
   * Redis commands per counter touch. A bucket is stored as a 6-field hash — a 5-slot mood
   * histogram plus summed intensity — so one contribution is two `HINCRBY`s. `n` and the mean mood
   * are *derived* from the histogram rather than stored, which both halves the command count and
   * removes any way for `n` and the histogram to drift apart.
   */
  redisCommandsPerKeyTouch: 2,
  /** Pipelined throughput per shard on commodity hardware. Unpipelined is ~10x lower. */
  redisOpsPerSecondPerShard: 1_000_000,
  redisShards: 64,

  secondsPerDay: 86_400,
};

export interface CapacityModel {
  monthlyActive: number;
  dailyActive: number;
  sessionsPerDay: number;
  writesPerDay: number;
  readsPerDay: number;
  avgWritesPerSecond: number;
  avgReadsPerSecond: number;
  diurnalPeakWritesPerSecond: number;
  spikeWritesPerSecond: number;
  spikeReadsPerSecond: number;
  originReadsPerSecondAtSpike: number;
  /** Counter increments touched per event: regions × (dimensions + 1). */
  rollupKeysPerEvent: number;
  rollupIncrementsPerDay: number;
  avgRollupIncrementsPerSecond: number;
  spikeRollupIncrementsPerSecond: number;
  coresAtSpike: number;
  podsAtSpike: number;
  logIngressMBps: number;
  logReplicatedMBps: number;
  logMBpsPerPartition: number;
  redisCommandsPerSecondAtSpike: number;
  redisCommandsPerSecondPerShardAtSpike: number;
  redisUtilisationAtSpike: number;
}

export function computeCapacity(a: CapacityAssumptions = ASSUMPTIONS): CapacityModel {
  const monthlyActive = a.registeredCitizens * a.monthlyActiveShare;
  const dailyActive = monthlyActive * a.dailyActiveShareOfMonthly;
  const sessionsPerDay = dailyActive * a.sessionsPerDailyActive;
  const writesPerDay = sessionsPerDay * a.sentimentWritesPerSession;
  const readsPerDay = sessionsPerDay * a.aggregateReadsPerSession;

  const avgWritesPerSecond = writesPerDay / a.secondsPerDay;
  const avgReadsPerSecond = readsPerDay / a.secondsPerDay;

  const spikeWritesPerSecond = avgWritesPerSecond * a.eventSpikeMultiplier;
  const spikeReadsPerSecond = avgReadsPerSecond * a.readSpikeMultiplier;

  const rollupKeysPerEvent = ROLLUP_FANOUT * (DEMOGRAPHIC_DIMENSIONS.length + 1);
  const rollupIncrementsPerDay = writesPerDay * rollupKeysPerEvent;

  const coresAtSpike = (spikeWritesPerSecond * a.cpuMsPerWrite) / 1000;

  const logIngressMBps = (spikeWritesPerSecond * a.bytesPerEvent) / 1_000_000;

  const spikeRollupIncrementsPerSecond =
    (rollupIncrementsPerDay / a.secondsPerDay) * a.eventSpikeMultiplier;
  const redisCommandsPerSecondAtSpike =
    spikeRollupIncrementsPerSecond * a.redisCommandsPerKeyTouch;
  const redisCommandsPerSecondPerShardAtSpike = redisCommandsPerSecondAtSpike / a.redisShards;

  return {
    monthlyActive,
    dailyActive,
    sessionsPerDay,
    writesPerDay,
    readsPerDay,
    avgWritesPerSecond,
    avgReadsPerSecond,
    diurnalPeakWritesPerSecond: avgWritesPerSecond * a.diurnalPeakMultiplier,
    spikeWritesPerSecond,
    spikeReadsPerSecond,
    originReadsPerSecondAtSpike: spikeReadsPerSecond * (1 - a.edgeHitRate),
    rollupKeysPerEvent,
    rollupIncrementsPerDay,
    avgRollupIncrementsPerSecond: rollupIncrementsPerDay / a.secondsPerDay,
    spikeRollupIncrementsPerSecond,
    coresAtSpike,
    podsAtSpike: Math.ceil(coresAtSpike / a.coresPerPod),
    logIngressMBps,
    logReplicatedMBps: logIngressMBps * a.logReplicationFactor,
    logMBpsPerPartition: (logIngressMBps * a.logReplicationFactor) / a.logPartitions,
    redisCommandsPerSecondAtSpike,
    redisCommandsPerSecondPerShardAtSpike,
    redisUtilisationAtSpike: redisCommandsPerSecondPerShardAtSpike / a.redisOpsPerSecondPerShard,
  };
}

/**
 * What crossing the demographic dimensions would have cost (ADR-0002). Kept as code so the
 * trade-off can be re-checked rather than taken on faith.
 */
export function crossProductCardinality(): number {
  let n = 1;
  for (const dim of DEMOGRAPHIC_DIMENSIONS) {
    n *= DIMENSION_SIZES[dim];
  }
  return n;
}

const DIMENSION_SIZES: Record<(typeof DEMOGRAPHIC_DIMENSIONS)[number], number> = {
  age_band: 6,
  gender: 3,
  urbanity: 2,
  income_band: 5,
  education_band: 5,
  occupation_band: 8,
};

/** How much cheaper marginals are than the cross-product, per (topic, region, day, tier). */
export function marginalSavingsFactor(): number {
  const marginal = Object.values(DIMENSION_SIZES).reduce((a, b) => a + b, 0) + 1;
  return crossProductCardinality() / marginal;
}
