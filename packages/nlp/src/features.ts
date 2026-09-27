import { normalize, tokenize } from './text.ts';

/**
 * Feature extraction by the hashing trick over character n-grams and word n-grams.
 *
 * Character n-grams are the reason this works across Telugu, Devanagari and romanised text without a
 * tokenizer or a vocabulary per language: "రోడ్లు", "రోడ్ల" and "రోడ్" share most of their 3- and
 * 4-grams, so an inflected form the model has never seen still lands near the ones it has. Hashing
 * keeps the model a fixed size no matter how much new vocabulary the forum produces.
 */
export const FEATURE_BITS = 18;
export const FEATURE_DIM = 1 << FEATURE_BITS;

export type SparseVector = Map<number, number>;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function add(vec: SparseVector, key: string, weight = 1): void {
  const index = fnv1a(key) & (FEATURE_DIM - 1);
  vec.set(index, (vec.get(index) ?? 0) + weight);
}

export interface FeatureOptions {
  charNgrams?: readonly number[];
  wordNgrams?: readonly number[];
}

const DEFAULTS: Required<FeatureOptions> = { charNgrams: [2, 3, 4], wordNgrams: [1, 2] };

export function featurize(text: string, options: FeatureOptions = {}): SparseVector {
  const { charNgrams, wordNgrams } = { ...DEFAULTS, ...options };
  const vec: SparseVector = new Map();
  const tokens = tokenize(normalize(text));

  for (const n of wordNgrams) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      add(vec, `w${n}:${tokens.slice(i, i + n).join(' ')}`);
    }
  }

  for (const token of tokens) {
    // Word-boundary padding, so a prefix n-gram is distinct from the same letters mid-word.
    const padded = `<${token}>`;
    // Iterate by code point: Indic characters are single code points, but splitting a UTF-16 string by
    // index would cut astral characters (emoji) in half.
    const chars = [...padded];
    for (const n of charNgrams) {
      for (let i = 0; i + n <= chars.length; i += 1) {
        add(vec, `c${n}:${chars.slice(i, i + n).join('')}`);
      }
    }
  }

  // Negation flips sentiment, and it is a single short word in every language here — easy for n-grams
  // to underweight, so it gets an explicit feature.
  if (tokens.some((t) => NEGATIONS.has(t)) || /నహీ|नहीं|లేదు|లేవు|కాదు/.test(text))
    add(vec, 'neg:present', 2);

  return vec;
}

const NEGATIONS = new Set([
  'not',
  'no',
  'never',
  'nahi',
  'nahin',
  'na',
  'ledu',
  'levu',
  'kaadu',
  "isn't",
  "don't",
]);
