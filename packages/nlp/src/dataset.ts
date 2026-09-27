import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEEDS, type Need } from './needs.ts';

/**
 * The seed dataset: hand-written civic comments in English, Hindi (Devanagari and romanised) and
 * Telugu (script and romanised), labelled for sentiment, needs and whether they propose an action.
 *
 * It is a *seed*: small, synthetic, and written by one author. It is enough to train a baseline that
 * clearly beats chance and to test the pipeline end to end. It is not enough to quote an accuracy
 * figure as if it described production traffic, and the evaluation report says so. The growth path is
 * docs/adr/0011: large-model labels on real, published comments, sampled for human review, folded back
 * in, with every aggregate stamped by the model version that produced it.
 */
export type SentimentLabel = 'negative' | 'neutral' | 'positive';

export interface LabelledComment {
  text: string;
  sentiment: SentimentLabel;
  needs: Need[];
  suggestion: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_PATH = join(here, '..', 'data', 'seed.jsonl');

const SENTIMENT: Record<string, SentimentLabel> = {
  '-1': 'negative',
  '0': 'neutral',
  '1': 'positive',
};

export function parseDataset(jsonl: string): LabelledComment[] {
  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      const row = JSON.parse(line) as { t: string; s: number; n: string[]; g: number };
      const sentiment = SENTIMENT[String(row.s)];
      if (!sentiment) throw new RangeError(`line ${i + 1}: bad sentiment ${row.s}`);
      for (const need of row.n) {
        if (!(NEEDS as readonly string[]).includes(need)) {
          throw new RangeError(`line ${i + 1}: unknown need ${need}`);
        }
      }
      return { text: row.t, sentiment, needs: row.n as Need[], suggestion: row.g === 1 };
    });
}

export function loadSeedDataset(): LabelledComment[] {
  return parseDataset(readFileSync(SEED_PATH, 'utf8'));
}

export function seedDatasetText(): string {
  return readFileSync(SEED_PATH, 'utf8');
}
