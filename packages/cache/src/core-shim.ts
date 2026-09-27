/**
 * Re-export of the core primitives the adapters need, plus one structural alias.
 *
 * `fromHistogram` wants the exact 5-tuple type, but a histogram decoded from a Redis hash is a
 * plain `number[]` until it is validated. The alias keeps that cast in one place instead of
 * scattering `as` through the adapter.
 */
export {
  emptyHistogram,
  emptyRawBucket,
  fromHistogram,
  moodIndex,
  QUOTAS,
} from '@civic-voice/core';
export type { CounterIncrement, RawBucket, RollupMutation } from '@civic-voice/core';
import type { MoodHistogram } from '@civic-voice/contracts';

export type MoodHistogramLike = MoodHistogram;
