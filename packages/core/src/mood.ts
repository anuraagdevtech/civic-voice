import { MOOD_VALUES, type Mood, type MoodHistogram } from '@civic-voice/contracts';
import { emptyHistogram, type RawBucket } from './anonymity.ts';

/** Position of a mood value in the −2..+2 histogram. */
export function moodIndex(mood: Mood): number {
  return mood + 2;
}

export function moodFromIndex(index: number): Mood {
  const v = MOOD_VALUES[index];
  if (v === undefined) throw new RangeError(`no mood at histogram index ${index}`);
  return v;
}

/**
 * Apply one signed contribution to a bucket. `delta` is +1 for a new or replacing opinion and −1
 * for the compensating retraction of a previous one, which is how a change of mind is recorded
 * without double-counting (ADR-0003, docs/ARCHITECTURE.md §6).
 */
export function applyDelta(
  bucket: RawBucket,
  mood: Mood,
  intensity: number,
  delta: 1 | -1,
): RawBucket {
  const histogram = [...bucket.histogram] as MoodHistogram;
  const i = moodIndex(mood);
  histogram[i] = Math.max(0, (histogram[i] as number) + delta);
  return {
    bucket: bucket.bucket,
    n: Math.max(0, bucket.n + delta),
    sumMood: bucket.sumMood + mood * delta,
    sumIntensity: bucket.sumIntensity + intensity * delta,
    histogram,
  };
}

export function mergeBuckets(a: RawBucket, b: RawBucket): RawBucket {
  const histogram = emptyHistogram();
  for (let i = 0; i < histogram.length; i += 1) {
    histogram[i] = (a.histogram[i] as number) + (b.histogram[i] as number);
  }
  return {
    bucket: a.bucket,
    n: a.n + b.n,
    sumMood: a.sumMood + b.sumMood,
    sumIntensity: a.sumIntensity + b.sumIntensity,
    histogram,
  };
}

/** Rebuild a bucket's scalars from its histogram — used by reconciliation to repair Redis drift. */
export function fromHistogram(
  bucket: string,
  histogram: MoodHistogram,
  sumIntensity = 0,
): RawBucket {
  let n = 0;
  let sumMood = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    const count = histogram[i] as number;
    n += count;
    sumMood += moodFromIndex(i) * count;
  }
  return { bucket, n, sumMood, sumIntensity, histogram };
}

/**
 * Net approval: the share who are hopeful or satisfied minus the share who are concerned or
 * angry. More legible to a citizen than a mean on a −2..+2 scale, and reported alongside it.
 */
export function netApproval(histogram: MoodHistogram): number | null {
  const n = histogram.reduce((a, b) => a + b, 0);
  if (n === 0) return null;
  const negative = (histogram[0] as number) + (histogram[1] as number);
  const positive = (histogram[3] as number) + (histogram[4] as number);
  return Math.round(((positive - negative) / n) * 1000) / 1000;
}

/**
 * Polarisation: the share at the extremes (±2) rather than the middle. A mean of zero can mean
 * "everyone is indifferent" or "the country is split in half", and those are opposite findings,
 * so the read API reports both.
 */
export function polarisation(histogram: MoodHistogram): number | null {
  const n = histogram.reduce((a, b) => a + b, 0);
  if (n === 0) return null;
  return Math.round((((histogram[0] as number) + (histogram[4] as number)) / n) * 1000) / 1000;
}
