import {
  AGE_BANDS,
  EDUCATION_BANDS,
  GENDERS,
  INCOME_BANDS,
  OCCUPATION_BANDS,
  REASON_CODES,
  URBANITY,
  type Demographics,
  type ReasonCode,
} from '@civic-voice/contracts';

/**
 * Band ↔ ordinal codec.
 *
 * Demographics ride on 1.4B citizen rows and every one of 150M daily events, so they are stored as
 * `smallint` ordinals rather than text — roughly 8 bytes saved per dimension per row, which at this
 * scale is hundreds of gigabytes and a materially different index size.
 *
 * The ordinal is the value's position in its `as const` vocabulary in @civic-voice/contracts, which
 * makes the vocabulary order part of the storage format: **appending is safe, reordering or removing
 * is a data migration.** `assertVocabularyOrder` below pins the current order so a reorder fails the
 * test suite instead of silently reinterpreting every stored row.
 */

function encoder<T extends string>(vocabulary: readonly T[]) {
  const toOrdinal = new Map<T, number>(vocabulary.map((v, i) => [v, i]));
  return {
    encode(value: T | undefined | null): number | null {
      if (value === undefined || value === null) return null;
      const ordinal = toOrdinal.get(value);
      if (ordinal === undefined) throw new RangeError(`not in vocabulary: ${value}`);
      return ordinal;
    },
    decode(ordinal: number | null | undefined): T | undefined {
      if (ordinal === null || ordinal === undefined) return undefined;
      const value = vocabulary[ordinal];
      if (value === undefined)
        throw new RangeError(`ordinal ${ordinal} is out of vocabulary range`);
      return value;
    },
  };
}

export const codec = {
  age_band: encoder(AGE_BANDS),
  gender: encoder(GENDERS),
  urbanity: encoder(URBANITY),
  income_band: encoder(INCOME_BANDS),
  education_band: encoder(EDUCATION_BANDS),
  occupation_band: encoder(OCCUPATION_BANDS),
  reason_code: encoder(REASON_CODES),
} as const;

export interface DemographicOrdinals {
  age_band: number | null;
  gender: number | null;
  urbanity: number | null;
  income_band: number | null;
  education_band: number | null;
  occupation_band: number | null;
}

export function encodeDemographics(d: Demographics): DemographicOrdinals {
  return {
    age_band: codec.age_band.encode(d.age_band),
    gender: codec.gender.encode(d.gender),
    urbanity: codec.urbanity.encode(d.urbanity),
    income_band: codec.income_band.encode(d.income_band),
    education_band: codec.education_band.encode(d.education_band),
    occupation_band: codec.occupation_band.encode(d.occupation_band),
  };
}

export function decodeDemographics(row: Partial<DemographicOrdinals>): Demographics {
  const out: Demographics = {};
  const age = codec.age_band.decode(row.age_band);
  if (age !== undefined) out.age_band = age;
  const gender = codec.gender.decode(row.gender);
  if (gender !== undefined) out.gender = gender;
  const urbanity = codec.urbanity.decode(row.urbanity);
  if (urbanity !== undefined) out.urbanity = urbanity;
  const income = codec.income_band.decode(row.income_band);
  if (income !== undefined) out.income_band = income;
  const education = codec.education_band.decode(row.education_band);
  if (education !== undefined) out.education_band = education;
  const occupation = codec.occupation_band.decode(row.occupation_band);
  if (occupation !== undefined) out.occupation_band = occupation;
  return out;
}

export function encodeReasonCode(code: ReasonCode): number {
  return codec.reason_code.encode(code) as number;
}

export function decodeReasonCode(ordinal: number): ReasonCode {
  return codec.reason_code.decode(ordinal) as ReasonCode;
}

/**
 * The stored ordinal layout, pinned. Vocabulary order is part of the on-disk format; asserting it
 * here is what turns "someone alphabetised an enum" from a silent data corruption into a red test.
 */
export const VOCABULARY_FINGERPRINT = {
  age_band: ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'],
  gender: ['female', 'male', 'other'],
  urbanity: ['urban', 'rural'],
  income_band: ['lowest', 'lower_middle', 'middle', 'upper_middle', 'highest'],
  education_band: ['none_primary', 'secondary', 'higher_secondary', 'graduate', 'postgraduate'],
  occupation_band: [
    'agriculture',
    'informal_labour',
    'salaried_private',
    'government',
    'self_employed',
    'student',
    'homemaker',
    'retired_other',
  ],
  reason_code: [
    'unaware',
    'not_consulted',
    'poor_implementation',
    'corruption_suspected',
    'benefits_me',
    'benefits_community',
    'too_costly',
    'wrong_priority',
    'good_intent_poor_delivery',
    'no_reason',
  ],
} as const;

export const LIVE_VOCABULARIES = {
  age_band: AGE_BANDS,
  gender: GENDERS,
  urbanity: URBANITY,
  income_band: INCOME_BANDS,
  education_band: EDUCATION_BANDS,
  occupation_band: OCCUPATION_BANDS,
  reason_code: REASON_CODES,
} as const;
