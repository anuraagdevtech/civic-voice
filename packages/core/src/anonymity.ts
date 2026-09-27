import type { MoodBucket, MoodHistogram } from '@civic-voice/contracts';

/**
 * The k-anonymity gate (docs/PRIVACY.md §3).
 *
 * Every published slice passes through this one function rather than each endpoint remembering to
 * apply a rule. Two properties matter, and the second is the one naive implementations miss:
 *
 *  1. **Threshold.** A bucket with fewer than `k` people is not published.
 *
 *  2. **Complementary suppression.** Thresholding alone leaks by subtraction. If a district's
 *     total is 1,000 and five of six age bands are published summing to 985, the suppressed band
 *     is 15 — precisely the number that was meant to be hidden. So when any bucket is suppressed,
 *     enough additional buckets are suppressed that the residual cannot be attributed to one of
 *     them: at least two unknowns, and a residual of at least `k` spread across them.
 *
 * Counts at or above `roundingFloor` are rounded to the nearest 10, which blunts differencing
 * attacks that compare the same slice on consecutive days. It does not defeat a determined
 * attacker with long observation, and is not claimed to.
 */

export const DEFAULT_K = 25;
export const DEFAULT_ROUNDING_FLOOR = 1_000;

export interface RawBucket {
  bucket: string;
  n: number;
  sumMood: number;
  sumIntensity: number;
  histogram: MoodHistogram;
}

export interface AnonymityOptions {
  /** Minimum cohort size. Callers may raise it; `applyAnonymityGate` never lowers it below DEFAULT_K. */
  k?: number;
  roundingFloor?: number;
  /** Buckets excluded by the anomaly detectors (docs/TRUST.md §4). Suppressed and labelled. */
  quarantined?: ReadonlySet<string>;
}

export interface GateResult {
  total: MoodBucket;
  buckets: MoodBucket[];
}

export function emptyHistogram(): MoodHistogram {
  return [0, 0, 0, 0, 0];
}

export function emptyRawBucket(bucket: string): RawBucket {
  return { bucket, n: 0, sumMood: 0, sumIntensity: 0, histogram: emptyHistogram() };
}

function roundCount(n: number, floor: number): number {
  return n >= floor ? Math.round(n / 10) * 10 : n;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function publish(raw: RawBucket, roundingFloor: number): MoodBucket {
  return {
    bucket: raw.bucket,
    n: roundCount(raw.n, roundingFloor),
    mean_mood: raw.n > 0 ? round2(raw.sumMood / raw.n) : null,
    mean_intensity: raw.n > 0 ? round2(raw.sumIntensity / raw.n) : null,
    histogram: raw.histogram,
    suppressed: false,
    suppression_reason: null,
  };
}

function suppress(
  bucket: string,
  reason: 'below_k' | 'complementary' | 'quarantined',
): MoodBucket {
  return {
    bucket,
    n: 0,
    mean_mood: null,
    mean_intensity: null,
    histogram: null,
    suppressed: true,
    suppression_reason: reason,
  };
}

export function applyAnonymityGate(
  total: RawBucket,
  buckets: readonly RawBucket[],
  options: AnonymityOptions = {},
): GateResult {
  const k = Math.max(options.k ?? DEFAULT_K, DEFAULT_K);
  const roundingFloor = options.roundingFloor ?? DEFAULT_ROUNDING_FLOOR;
  const quarantined = options.quarantined ?? new Set<string>();

  // If the whole slice is below k, nothing about it is publishable — not the buckets, and not the
  // total, since the total is itself a cohort size.
  if (total.n < k) {
    return {
      total: suppress(total.bucket, 'below_k'),
      buckets: buckets.map((b) => suppress(b.bucket, 'below_k')),
    };
  }

  const reasons = new Map<string, 'below_k' | 'complementary' | 'quarantined'>();
  for (const b of buckets) {
    if (quarantined.has(b.bucket)) {
      reasons.set(b.bucket, 'quarantined');
    } else if (b.n > 0 && b.n < k) {
      // A zero-count bucket is left publishable: "nobody here" identifies nobody. It contributes
      // nothing to the residual either, so it is not counted as an unknown below.
      reasons.set(b.bucket, 'below_k');
    }
  }

  if (reasons.size > 0) {
    // Complementary suppression. Withhold additional buckets, smallest first (they cost the least
    // information), until the residual hides at least two non-empty unknowns and sums to ≥ k.
    const candidates = buckets
      .filter((b) => !reasons.has(b.bucket) && b.n > 0)
      .sort((a, b) => a.n - b.n);

    const unknownCount = () => [...reasons.keys()].filter((name) => {
      const b = buckets.find((x) => x.bucket === name);
      return b !== undefined && b.n > 0;
    }).length;

    const residual = () =>
      buckets.filter((b) => reasons.has(b.bucket)).reduce((sum, b) => sum + b.n, 0);

    for (const c of candidates) {
      if (unknownCount() >= 2 && residual() >= k) break;
      reasons.set(c.bucket, 'complementary');
    }
  }

  return {
    total: publish(total, roundingFloor),
    buckets: buckets.map((b) => {
      const reason = reasons.get(b.bucket);
      return reason ? suppress(b.bucket, reason) : publish(b, roundingFloor);
    }),
  };
}

/**
 * Does a set of published buckets leak a suppressed one by subtraction? Used by the test suite to
 * assert the attack fails, and available to callers that assemble a slice by hand.
 *
 * Returns true when the residual (total minus everything published) can be attributed to a single
 * non-empty bucket, or is small enough to narrow one to a near-exact value.
 */
export function leaksBySubtraction(total: MoodBucket, buckets: readonly MoodBucket[], k = DEFAULT_K): boolean {
  if (total.suppressed) return false;
  const suppressedBuckets = buckets.filter((b) => b.suppressed);
  if (suppressedBuckets.length === 0) return false;
  const publishedSum = buckets
    .filter((b) => !b.suppressed)
    .reduce((sum, b) => sum + b.n, 0);
  const residual = total.n - publishedSum;
  // One unknown ⇒ the residual *is* that bucket. A residual below k ⇒ every unknown is pinned to a
  // range narrower than the threshold was meant to guarantee.
  return suppressedBuckets.length < 2 || residual < k;
}
