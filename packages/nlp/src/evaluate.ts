import type { LabelledComment, SentimentLabel } from './dataset.ts';
import {
  scoreNeeds,
  scoreSentiment,
  scoreSuggestion,
  trainModel,
  NEED_THRESHOLD,
  SUGGESTION_THRESHOLD,
} from './model.ts';
import { NEEDS, type Need } from './needs.ts';
import { detectLanguage } from './text.ts';

/**
 * Cross-validated evaluation.
 *
 * On a 241-example seed set a single train/test split is noise, so everything here is k-fold, stratified
 * by sentiment so every fold sees every class. Three things are always reported side by side, because a
 * number without a baseline says nothing:
 *
 *  - the majority-class baseline (predict "negative" for everything — 67% accurate on this data, which
 *    is exactly why accuracy alone is the wrong headline and macro-F1 is used instead),
 *  - the learned model alone, the lexicon alone, and the ensemble the platform actually runs.
 */

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface SentimentReport {
  accuracy: number;
  macroF1: number;
  perClass: Record<SentimentLabel, ClassMetrics>;
  confusion: Record<SentimentLabel, Record<SentimentLabel, number>>;
  majorityBaseline: { accuracy: number; macroF1: number };
  byLanguage: Record<string, { n: number; accuracy: number }>;
  /**
   * Expected calibration error over 10 confidence bins: how far "80% sure" is from being right 80% of
   * the time. Escalation to the large model is decided on confidence, so this is what makes that
   * threshold mean anything. Reported with and without the fitted temperature.
   */
  calibration: { ece: number; eceUncalibrated: number; meanConfidence: number };
}

export interface MultiLabelReport {
  microF1: number;
  macroF1: number;
  perLabel: Record<string, ClassMetrics>;
}

export interface EvaluationReport {
  folds: number;
  examples: number;
  sentiment: SentimentReport;
  needs: {
    ensemble: MultiLabelReport;
    learnedOnly: MultiLabelReport;
    lexiconOnly: MultiLabelReport;
  };
  suggestion: { ensemble: ClassMetrics; learnedOnly: ClassMetrics; lexiconOnly: ClassMetrics };
  caveat: string;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function metrics(tp: number, fp: number, fn: number): ClassMetrics {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision: round(precision), recall: round(recall), f1: round(f1), support: tp + fn };
}

/** Deterministic stratified folds: round-robin within each class. */
export function stratifiedFolds<T>(
  items: readonly T[],
  key: (item: T) => string,
  k: number,
): number[][] {
  const byClass = new Map<string, number[]>();
  items.forEach((item, i) => {
    const c = key(item);
    byClass.set(c, [...(byClass.get(c) ?? []), i]);
  });
  const folds: number[][] = Array.from({ length: k }, () => []);
  for (const indices of byClass.values()) {
    indices.forEach((index, j) => (folds[j % k] as number[]).push(index));
  }
  return folds;
}

const LABELS: SentimentLabel[] = ['negative', 'neutral', 'positive'];

export function evaluate(dataset: readonly LabelledComment[], k = 5): EvaluationReport {
  const folds = stratifiedFolds(dataset, (e) => e.sentiment, k);

  const confusion = Object.fromEntries(
    LABELS.map((a) => [a, Object.fromEntries(LABELS.map((b) => [b, 0]))]),
  ) as Record<SentimentLabel, Record<SentimentLabel, number>>;
  const byLanguage = new Map<string, { n: number; correct: number }>();
  const reliability: Array<{ confidence: number; correct: boolean }> = [];
  const reliabilityRaw: Array<{ confidence: number; correct: boolean }> = [];
  const ece = (rows: ReadonlyArray<{ confidence: number; correct: boolean }>) => {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, correct: 0 }));
    for (const r of rows) {
      const bin = bins[Math.min(9, Math.floor(r.confidence * 10))] as {
        n: number;
        conf: number;
        correct: number;
      };
      bin.n += 1;
      bin.conf += r.confidence;
      bin.correct += r.correct ? 1 : 0;
    }
    return bins.reduce(
      (sum, b) =>
        b.n === 0 ? sum : sum + (b.n / rows.length) * Math.abs(b.conf / b.n - b.correct / b.n),
      0,
    );
  };

  type Counts = { tp: number; fp: number; fn: number };
  const fresh = (): Record<Need, Counts> =>
    Object.fromEntries(NEEDS.map((n) => [n, { tp: 0, fp: 0, fn: 0 }])) as Record<Need, Counts>;
  const needCounts = { ensemble: fresh(), learnedOnly: fresh(), lexiconOnly: fresh() };
  const suggestionCounts = {
    ensemble: { tp: 0, fp: 0, fn: 0 },
    learnedOnly: { tp: 0, fp: 0, fn: 0 },
    lexiconOnly: { tp: 0, fp: 0, fn: 0 },
  };

  for (let f = 0; f < k; f += 1) {
    const testIndices = new Set(folds[f]);
    const train = dataset.filter((_, i) => !testIndices.has(i));
    const model = trainModel(train);

    for (const i of testIndices) {
      const example = dataset[i] as LabelledComment;

      const scored = scoreSentiment(model, example.text);
      const predicted = scored.label;
      reliability.push({ confidence: scored.confidence, correct: predicted === example.sentiment });
      const raw = scoreSentiment(
        { ...model, sentiment: { ...model.sentiment, temperature: 1 } },
        example.text,
      );
      reliabilityRaw.push({ confidence: raw.confidence, correct: raw.label === example.sentiment });
      confusion[example.sentiment][predicted] += 1;
      const { language } = detectLanguage(example.text);
      const lang = byLanguage.get(language) ?? { n: 0, correct: 0 };
      lang.n += 1;
      if (predicted === example.sentiment) lang.correct += 1;
      byLanguage.set(language, lang);

      const variants = {
        ensemble: {},
        learnedOnly: { useLexicon: false },
        lexiconOnly: { useLearned: false },
      } as const;

      for (const [name, options] of Object.entries(variants) as Array<
        [keyof typeof variants, (typeof variants)[keyof typeof variants]]
      >) {
        const predictedNeeds = new Set(scoreNeeds(model, example.text, options).map((n) => n.need));
        for (const need of NEEDS) {
          const actual = example.needs.includes(need);
          const guess = predictedNeeds.has(need);
          const c = needCounts[name][need];
          if (actual && guess) c.tp += 1;
          else if (!actual && guess) c.fp += 1;
          else if (actual && !guess) c.fn += 1;
        }

        const s = scoreSuggestion(model, example.text, options) >= SUGGESTION_THRESHOLD;
        const sc = suggestionCounts[name];
        if (example.suggestion && s) sc.tp += 1;
        else if (!example.suggestion && s) sc.fp += 1;
        else if (example.suggestion && !s) sc.fn += 1;
      }
    }
  }

  const perClass = Object.fromEntries(
    LABELS.map((label) => {
      const tp = confusion[label][label];
      const fp = LABELS.filter((o) => o !== label).reduce((s, o) => s + confusion[o][label], 0);
      const fn = LABELS.filter((o) => o !== label).reduce((s, o) => s + confusion[label][o], 0);
      return [label, metrics(tp, fp, fn)];
    }),
  ) as Record<SentimentLabel, ClassMetrics>;

  const correct = LABELS.reduce((s, l) => s + confusion[l][l], 0);

  // Majority baseline: always predict the most common class.
  const support = LABELS.map((l) => [l, perClass[l].support] as const).sort((a, b) => b[1] - a[1]);
  const majority = support[0]?.[0] as SentimentLabel;
  const majorityRecallF1 = metrics(
    perClass[majority].support,
    dataset.length - perClass[majority].support,
    0,
  ).f1;

  const multiLabel = (counts: Record<Need, Counts>): MultiLabelReport => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const perLabel: Record<string, ClassMetrics> = {};
    for (const need of NEEDS) {
      const c = counts[need];
      tp += c.tp;
      fp += c.fp;
      fn += c.fn;
      perLabel[need] = metrics(c.tp, c.fp, c.fn);
    }
    const macro = NEEDS.reduce((s, n) => s + (perLabel[n] as ClassMetrics).f1, 0) / NEEDS.length;
    return { microF1: metrics(tp, fp, fn).f1, macroF1: round(macro), perLabel };
  };

  return {
    folds: k,
    examples: dataset.length,
    sentiment: {
      accuracy: round(correct / dataset.length),
      macroF1: round(LABELS.reduce((s, l) => s + perClass[l].f1, 0) / LABELS.length),
      perClass,
      confusion,
      calibration: {
        ece: round(ece(reliability)),
        eceUncalibrated: round(ece(reliabilityRaw)),
        meanConfidence: round(
          reliability.reduce((sum, r) => sum + r.confidence, 0) / Math.max(1, reliability.length),
        ),
      },
      majorityBaseline: {
        accuracy: round(perClass[majority].support / dataset.length),
        // One class at F1 = its own score, the other two at zero.
        macroF1: round(majorityRecallF1 / LABELS.length),
      },
      byLanguage: Object.fromEntries(
        [...byLanguage].map(([language, v]) => [
          language,
          { n: v.n, accuracy: round(v.correct / v.n) },
        ]),
      ),
    },
    needs: {
      ensemble: multiLabel(needCounts.ensemble),
      learnedOnly: multiLabel(needCounts.learnedOnly),
      lexiconOnly: multiLabel(needCounts.lexiconOnly),
    },
    suggestion: {
      ensemble: metrics(
        suggestionCounts.ensemble.tp,
        suggestionCounts.ensemble.fp,
        suggestionCounts.ensemble.fn,
      ),
      learnedOnly: metrics(
        suggestionCounts.learnedOnly.tp,
        suggestionCounts.learnedOnly.fp,
        suggestionCounts.learnedOnly.fn,
      ),
      lexiconOnly: metrics(
        suggestionCounts.lexiconOnly.tp,
        suggestionCounts.lexiconOnly.fp,
        suggestionCounts.lexiconOnly.fn,
      ),
    },
    caveat:
      `Measured by ${k}-fold cross-validation on a ${dataset.length}-example hand-written seed set. ` +
      'Indicative of relative performance between variants; NOT an estimate of accuracy on real ' +
      'forum traffic, which needs a held-out sample of real comments labelled by people.',
  };
}

export { NEED_THRESHOLD };
