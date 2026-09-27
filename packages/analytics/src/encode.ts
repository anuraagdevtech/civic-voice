import type { Demographics, ReasonCode } from '@civic-voice/contracts';
import { codec } from '@civic-voice/db';

/**
 * Demographics are stored in ClickHouse as the same ordinals Postgres uses, so a figure computed
 * from the analytical store and one computed from the OLTP store cannot disagree about what band a
 * row is in. The codec lives in @civic-voice/db because that is where the vocabulary fingerprint is
 * pinned; importing it here rather than reimplementing it is the point.
 */
export function encodeDemographicsForAnalytics(d: Demographics): Record<string, number | null> {
  return {
    age_band: codec.age_band.encode(d.age_band),
    gender: codec.gender.encode(d.gender),
    urbanity: codec.urbanity.encode(d.urbanity),
    income_band: codec.income_band.encode(d.income_band),
    education_band: codec.education_band.encode(d.education_band),
    occupation_band: codec.occupation_band.encode(d.occupation_band),
    employment_status: codec.employment_status.encode(d.employment_status),
  };
}

export function encodeReasonCodeForAnalytics(code: ReasonCode): number {
  return codec.reason_code.encode(code) as number;
}
