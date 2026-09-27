import { createHash } from 'node:crypto';
import {
  fitTemperature,
  naiveBayesScores,
  predictLogistic,
  softmaxAt,
  trainLogistic,
  trainNaiveBayes,
  type LogisticModel,
  type NaiveBayesModel,
} from './classifiers.ts';
import {
  loadSeedDataset,
  seedDatasetText,
  type LabelledComment,
  type SentimentLabel,
} from './dataset.ts';
import { featurize, type SparseVector } from './features.ts';
import { moderate, type ModerationResult } from './moderation.ts';
import { lexiconNeeds, NEEDS, suggestionHits, type Need } from './needs.ts';
import { detectLanguage, normalize, tokenize, type Language, type Script } from './text.ts';

/**
 * The comment model: sentiment, needs and suggestion, plus the moderation verdict, for one comment.
 *
 * What each component is made of was decided by measurement (`evaluate.ts`, `pnpm nlp:evaluate`), not
 * assumed, and the measurement did not say the same thing for each:
 *
 *  - **Sentiment** — naive Bayes over character and word n-grams. Clearly beats the majority baseline
 *    in every language, including native-script Hindi and Telugu (after fixing an out-of-vocabulary
 *    bug the evaluation exposed; see `predictNaiveBayes`).
 *  - **Suggestion** — learned model *and* marker lexicon. The ensemble beats either alone.
 *  - **Needs** — mostly the lexicon. At the seed data size the learned needs model overfits: it fits
 *    its training data perfectly and generalises at F1 ≈ 0.27, and no regularisation setting in a grid
 *    search moved that past 0.28 — with ~20 positives per need spread over five scripts, there are
 *    about four examples of each need per language. It is kept only at a high-precision threshold,
 *    where it is right ~95% of the time it fires, so it can add a need the lexicon missed without
 *    adding noise. As labelled data accumulates through the escalation loop (docs/adr/0011), this is
 *    the component expected to change most, and the evaluation is what will say when.
 */

export interface CommentAnalysis {
  language: Language;
  script: Script;
  sentiment: {
    label: SentimentLabel;
    confidence: number;
    coverage: number;
    probabilities: Record<SentimentLabel, number>;
  };
  /** The −2..+2 mood scale the rest of the platform uses, derived from sentiment and its strength. */
  mood: -2 | -1 | 0 | 1 | 2;
  needs: Array<{ need: Need; score: number }>;
  suggestion: { value: boolean; score: number };
  moderation: ModerationResult;
  /** Below this, the analysis is escalated to the large model rather than trusted (docs/adr/0011). */
  lowConfidence: boolean;
  modelVersion: string;
}

export interface TrainedModel {
  version: string;
  sentiment: NaiveBayesModel;
  needs: Record<Need, LogisticModel>;
  suggestion: LogisticModel;
  trainedOn: number;
}

export const NEED_THRESHOLD = 0.5;
/**
 * The learned needs model only contributes above this. It is precise when confident and unreliable
 * otherwise at the current data size, so it is used as a supplement to the lexicon, not a peer.
 */
export const LEARNED_NEED_THRESHOLD = 0.8;
export const SUGGESTION_THRESHOLD = 0.5;
/** Calibrated sentiment confidence below which the analysis is flagged for escalation. */
export const ESCALATION_CONFIDENCE = 0.6;
/**
 * Share of a comment's features the model saw in training, below which it is flagged too, whatever
 * its probabilities say: a model that recognises under half of what it is reading — a language or
 * register it was not trained on — does not know what it does not know.
 */
export const MIN_COVERAGE = 0.5;

/** A lexicon hit is strong evidence; the learned score is raised to at least this when one fires. */
const LEXICON_FLOOR = 0.7;

export const HYPERPARAMETERS = {
  nbAlpha: 0.5,
  lrEpochs: 30,
  lrRate: 2,
  lrL2: 1e-5,
  features: 'char[2,3,4]+word[1,2]+neg',
} as const;

/** Folds used to fit the sentiment model's temperature on held-out scores. */
const CALIBRATION_FOLDS = 5;

export function trainModel(examples: readonly LabelledComment[], versionSalt = ''): TrainedModel {
  const vectors = examples.map((e) => featurize(e.text));
  const labels = examples.map((e) => e.sentiment);

  const sentiment = trainNaiveBayes(vectors, labels, HYPERPARAMETERS.nbAlpha);

  // Calibrate on scores the model produced for examples it did not train on: each fold scored by a
  // model trained on the others. Training NB is counting, so five extra fits cost milliseconds.
  const heldOut: Array<{ scores: number[]; label: number }> = [];
  const folds = Array.from({ length: CALIBRATION_FOLDS }, () => [] as number[]);
  const byClass = new Map<string, number[]>();
  labels.forEach((l, i) => byClass.set(l, [...(byClass.get(l) ?? []), i]));
  for (const indices of byClass.values())
    indices.forEach((index, j) => (folds[j % CALIBRATION_FOLDS] as number[]).push(index));
  for (const fold of folds) {
    if (fold.length === 0) continue;
    const held = new Set(fold);
    const trainIdx = vectors.map((_, i) => i).filter((i) => !held.has(i));
    const foldModel = trainNaiveBayes(
      trainIdx.map((i) => vectors[i] as SparseVector),
      trainIdx.map((i) => labels[i] as string),
      HYPERPARAMETERS.nbAlpha,
    );
    for (const i of fold) {
      const { scores } = naiveBayesScores(foldModel, vectors[i] as SparseVector);
      heldOut.push({ scores, label: foldModel.classes.indexOf(labels[i] as string) });
    }
  }
  sentiment.temperature = fitTemperature(heldOut.filter((h) => h.label >= 0));

  const needs = {} as Record<Need, LogisticModel>;
  for (const need of NEEDS) {
    needs[need] = trainLogistic(
      vectors,
      examples.map((e) => (e.needs.includes(need) ? 1 : 0)),
      {
        epochs: HYPERPARAMETERS.lrEpochs,
        learningRate: HYPERPARAMETERS.lrRate,
        l2: HYPERPARAMETERS.lrL2,
      },
    );
  }

  const suggestion = trainLogistic(
    vectors,
    examples.map((e) => (e.suggestion ? 1 : 0)),
    {
      epochs: HYPERPARAMETERS.lrEpochs,
      learningRate: HYPERPARAMETERS.lrRate,
      l2: HYPERPARAMETERS.lrL2,
    },
  );

  // The version identifies exactly what produced a label, so an aggregate built from these labels can
  // be recomputed — or discounted — when the model changes.
  const version = createHash('sha256')
    .update(JSON.stringify(HYPERPARAMETERS))
    .update(versionSalt)
    .update(JSON.stringify(examples.map((e) => [e.text, e.sentiment, e.needs, e.suggestion])))
    .digest('hex')
    .slice(0, 12);

  return { version: `nb-lr-${version}`, sentiment, needs, suggestion, trainedOn: examples.length };
}

/** Train on the bundled seed dataset. Milliseconds, deterministic, so services can do it at startup. */
export function trainSeedModel(): TrainedModel {
  return trainModel(loadSeedDataset(), seedDatasetText().length.toString());
}

export interface ScoringOptions {
  useLexicon?: boolean;
  useLearned?: boolean;
}

export function scoreNeeds(
  model: TrainedModel,
  text: string,
  options: ScoringOptions = {},
): Array<{ need: Need; score: number }> {
  const { useLexicon = true, useLearned = true } = options;
  const vec = featurize(text);
  const tokens = tokenize(normalize(text));
  const hits = lexiconNeeds(tokens, text.normalize('NFC').toLowerCase());

  return NEEDS.map((need) => {
    const raw = useLearned ? predictLogistic(model.needs[need], vec) : 0;
    // In the ensemble the learned score counts only when confident; alone, it is reported as-is so the
    // evaluation can show what it does on its own.
    const learned = useLexicon && raw < LEARNED_NEED_THRESHOLD ? 0 : raw;
    const lexical = useLexicon && hits.has(need) ? LEXICON_FLOOR : 0;
    return { need, score: Math.round(Math.max(learned, lexical) * 1000) / 1000 };
  })
    .filter((n) => n.score >= NEED_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}

export function scoreSuggestion(
  model: TrainedModel,
  text: string,
  options: ScoringOptions = {},
): number {
  const { useLexicon = true, useLearned = true } = options;
  const learned = useLearned ? predictLogistic(model.suggestion, featurize(text)) : 0;
  const markers = useLexicon
    ? suggestionHits(tokenize(normalize(text)), text.normalize('NFC').toLowerCase())
    : 0;
  return Math.max(learned, markers > 0 ? 0.65 : 0);
}

export function scoreSentiment(model: TrainedModel, text: string) {
  const { scores, coverage } = naiveBayesScores(model.sentiment, featurize(text));
  const probs = softmaxAt(scores, model.sentiment.temperature ?? 1);
  const p = (label: SentimentLabel) => probs[model.sentiment.classes.indexOf(label)] ?? 0;
  const ordered = (['negative', 'neutral', 'positive'] as const)
    .map((label) => [label, p(label)] as const)
    .sort((a, b) => b[1] - a[1]);
  const [label, confidence] = ordered[0] as readonly [SentimentLabel, number];
  return {
    label,
    confidence: Math.round(confidence * 1000) / 1000,
    coverage: Math.round(coverage * 1000) / 1000,
    probabilities: {
      negative: Math.round(p('negative') * 1000) / 1000,
      neutral: Math.round(p('neutral') * 1000) / 1000,
      positive: Math.round(p('positive') * 1000) / 1000,
    },
  };
}

/**
 * Map a three-way sentiment to the five-point mood scale used by the rest of the platform. A confident
 * negative is "angry", a hesitant one "concerned" — the strength of the language is the only intensity
 * signal a comment carries.
 */
export function moodFromSentiment(label: SentimentLabel, confidence: number): -2 | -1 | 0 | 1 | 2 {
  if (label === 'neutral') return 0;
  const strong = confidence >= 0.85;
  if (label === 'negative') return strong ? -2 : -1;
  return strong ? 2 : 1;
}

export function analyze(model: TrainedModel, text: string): CommentAnalysis {
  const { language, script } = detectLanguage(text);
  const sentiment = scoreSentiment(model, text);
  const needs = scoreNeeds(model, text);
  const suggestionScore = scoreSuggestion(model, text);

  return {
    language,
    script,
    sentiment,
    mood: moodFromSentiment(sentiment.label, sentiment.confidence),
    needs,
    suggestion: {
      value: suggestionScore >= SUGGESTION_THRESHOLD,
      score: Math.round(suggestionScore * 1000) / 1000,
    },
    moderation: moderate(text),
    lowConfidence:
      sentiment.confidence < ESCALATION_CONFIDENCE || sentiment.coverage < MIN_COVERAGE,
    modelVersion: model.version,
  };
}
