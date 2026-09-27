import {
  DEFAULT_PUBLIC_TIER,
  VERIFICATION_TIERS,
  type VerificationTier,
} from '@civic-voice/contracts';

/**
 * Verification tiers and Sybil resistance (docs/TRUST.md).
 *
 * A sentiment platform that can be brigaded is worthless at any size, and at 1B users it is a
 * national-scale target. Participation is never blocked — it is labelled — and the default public
 * view counts T2+ only, with the lower tiers published alongside on a separate axis.
 */

export function countsInPublicView(tier: VerificationTier): boolean {
  return tier >= DEFAULT_PUBLIC_TIER;
}

export function tiersAtOrAbove(tier: VerificationTier): VerificationTier[] {
  return Object.values(VERIFICATION_TIERS).filter((t) => t >= tier);
}

/**
 * How far the unverified crowd diverges from the verified one, on the −2..+2 mood scale (so the
 * range is 0..4). A large divergence is not proof of manipulation, but it is the signal worth
 * exposing rather than hiding: the API returns it so readers can judge for themselves.
 */
export function tierDivergence(
  anonymousMeanMood: number | null,
  verifiedMeanMood: number | null,
): number | null {
  if (anonymousMeanMood === null || verifiedMeanMood === null) return null;
  return Math.round(Math.abs(anonymousMeanMood - verifiedMeanMood) * 100) / 100;
}

/** Write-path quotas. All three are evaluated in a single Redis pipeline (docs/TRUST.md §3). */
export const QUOTAS = {
  /** Bounds a compromised or automated account. */
  perCitizenPerHour: 60,
  perCitizenBurst: 10,
  /** Stops flip-flop amplification on one topic while still allowing genuine changes of mind. */
  topicCooldownSeconds: 600,
} as const;

// ───────────────────────── Anomaly detectors ─────────────────────────
//
// These run in the worker, off the hot path, and they quarantine *aggregates* rather than people.
// A flagged window is excluded from the default view with the exclusion disclosed in the API
// response. Detection never silently rewrites the record and never bans an account on its own.

export interface VelocityWindow {
  regionId: number;
  topicId: number;
  /** Submissions observed in the window. */
  observed: number;
  /** This region's own trailing median for comparable windows. */
  baselineMedian: number;
  windowSeconds: number;
}

export interface Anomaly {
  kind: 'velocity' | 'population_share' | 'homogeneity' | 'device_cluster';
  severity: 'watch' | 'quarantine';
  detail: string;
}

/**
 * Submissions far above a region's own trailing baseline. Compared against the region's own
 * history rather than a global constant, because a district of 3M and a district of 80k have
 * nothing in common — a global threshold would either miss the small one or flag the large one
 * every evening.
 */
export function detectVelocityAnomaly(
  w: VelocityWindow,
  watchFactor = 8,
  quarantineFactor = 25,
): Anomaly | null {
  // A cold baseline cannot be exceeded by a factor; require a floor of activity before judging.
  const baseline = Math.max(w.baselineMedian, 5);
  const ratio = w.observed / baseline;
  if (ratio >= quarantineFactor) {
    return {
      kind: 'velocity',
      severity: 'quarantine',
      detail: `${w.observed} submissions in ${w.windowSeconds}s is ${ratio.toFixed(1)}× this region's baseline`,
    };
  }
  if (ratio >= watchFactor) {
    return {
      kind: 'velocity',
      severity: 'watch',
      detail: `${w.observed} submissions is ${ratio.toFixed(1)}× this region's baseline`,
    };
  }
  return null;
}

/**
 * A hard, auditable ceiling: participation in a region cannot plausibly exceed a fraction of its
 * census population. Unlike the statistical detectors this one cannot produce a false positive
 * that matters — exceeding it is arithmetically impossible for genuine traffic.
 */
export function detectPopulationShareViolation(
  participants: number,
  population: number,
  maxShare = 0.35,
): Anomaly | null {
  if (population <= 0) return null;
  const share = participants / population;
  if (share > maxShare) {
    return {
      kind: 'population_share',
      severity: 'quarantine',
      detail: `${participants} participants is ${(share * 100).toFixed(1)}% of a population of ${population}`,
    };
  }
  return null;
}

/**
 * Implausible uniformity. Genuine public opinion is never unanimous at full intensity; a coordinated
 * push usually is, because it is one script. Measured as normalised Shannon entropy over the mood
 * histogram, so it is scale-free and comparable across regions.
 */
export function detectHomogeneityAnomaly(
  histogram: readonly number[],
  minSampleSize = 200,
  quarantineEntropy = 0.08,
  watchEntropy = 0.25,
): Anomaly | null {
  const n = histogram.reduce((a, b) => a + b, 0);
  if (n < minSampleSize) return null;

  let entropy = 0;
  for (const count of histogram) {
    if (count === 0) continue;
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  const normalised = entropy / Math.log2(histogram.length);

  if (normalised <= quarantineEntropy) {
    return {
      kind: 'homogeneity',
      severity: 'quarantine',
      detail: `normalised mood entropy ${normalised.toFixed(3)} over ${n} submissions is implausibly uniform`,
    };
  }
  if (normalised <= watchEntropy) {
    return {
      kind: 'homogeneity',
      severity: 'watch',
      detail: `normalised mood entropy ${normalised.toFixed(3)} over ${n} submissions is unusually uniform`,
    };
  }
  return null;
}

/** Many accounts sharing attestation fingerprints or install provenance. */
export function detectDeviceCluster(
  accountsPerFingerprint: number,
  watchThreshold = 12,
  quarantineThreshold = 50,
): Anomaly | null {
  if (accountsPerFingerprint >= quarantineThreshold) {
    return {
      kind: 'device_cluster',
      severity: 'quarantine',
      detail: `${accountsPerFingerprint} accounts share one device fingerprint`,
    };
  }
  if (accountsPerFingerprint >= watchThreshold) {
    return {
      kind: 'device_cluster',
      severity: 'watch',
      detail: `${accountsPerFingerprint} accounts share one device fingerprint`,
    };
  }
  return null;
}

export function shouldQuarantine(anomalies: readonly Anomaly[]): boolean {
  return anomalies.some((a) => a.severity === 'quarantine');
}
