import { FEATURE_DIM, type SparseVector } from './features.ts';

/**
 * Two small, dependency-free linear classifiers over sparse features.
 *
 * Why these and not a transformer: this model runs on *every* comment, in the worker, synchronously
 * with moderation. It has to be cheap enough to keep up with the forum at national scale and it must
 * have no GPU or Python dependency. Linear models over character n-grams are a strong baseline for
 * short-text sentiment and topic classification — and the hard cases, where they are unsure, are
 * escalated to a large model rather than guessed at (docs/adr/0011).
 */

// ─────────────────────────── Multinomial naive Bayes ───────────────────────────

export interface NaiveBayesModel {
  kind: 'naive_bayes';
  classes: string[];
  /** log P(class) */
  priors: number[];
  /** per class: feature index → log P(feature | class), for features seen in training */
  logLikelihood: Array<Record<number, number>>;
  /** per class: log P(unseen feature | class), from Laplace smoothing */
  unseen: number[];
  /**
   * Divides the class scores before the softmax. Multinomial NB over overlapping n-grams counts the
   * same evidence many times — "drain", "drai", "rain" and "drains overflow" all fire on one word — so
   * its raw probabilities sit at 0 and 1 whatever the text. Fitted on held-out folds (temperature
   * scaling); 1 means uncalibrated.
   */
  temperature?: number;
}

export function trainNaiveBayes(
  vectors: readonly SparseVector[],
  labels: readonly string[],
  alpha = 0.5,
): NaiveBayesModel {
  if (vectors.length !== labels.length) throw new RangeError('vectors and labels differ in length');
  const classes = [...new Set(labels)].sort();
  const counts = classes.map(() => new Map<number, number>());
  const totals = classes.map(() => 0);
  const docs = classes.map(() => 0);
  const vocabulary = new Set<number>();

  vectors.forEach((vec, i) => {
    const c = classes.indexOf(labels[i] as string);
    docs[c] = (docs[c] as number) + 1;
    for (const [feature, value] of vec) {
      const m = counts[c] as Map<number, number>;
      m.set(feature, (m.get(feature) ?? 0) + value);
      totals[c] = (totals[c] as number) + value;
      vocabulary.add(feature);
    }
  });

  const v = vocabulary.size;
  const n = vectors.length;
  return {
    kind: 'naive_bayes',
    classes,
    priors: docs.map((d) => Math.log((d + 1) / (n + classes.length))),
    // Every class gets an entry for every vocabulary feature, including ones that class never saw
    // (smoothed). That makes "in no table" mean exactly "out of vocabulary", which prediction needs.
    logLikelihood: counts.map((m, c) => {
      const denominator = (totals[c] as number) + alpha * v;
      const out: Record<number, number> = {};
      for (const feature of vocabulary)
        out[feature] = Math.log(((m.get(feature) ?? 0) + alpha) / denominator);
      return out;
    }),
    unseen: totals.map((t) => Math.log(alpha / (t + alpha * v))),
  };
}

function softmax(scores: readonly number[]): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Features never seen in training are **dropped**, not smoothed.
 *
 * Smoothing an out-of-vocabulary feature adds log(α / (total_c + αV)) to each class — a term that is
 * *larger for classes with fewer training tokens*. So every unfamiliar n-gram nudges the prediction
 * toward the smallest class. On this data that was not subtle: a Devanagari comment is ~40% OOV
 * n-grams, each one worth ~1.15 nats toward "neutral", and Hindi sentiment accuracy was 26% — worse
 * than guessing. The cross-validated evaluation is what exposed it.
 */
/** Raw class scores, and how much of the input the model has ever seen. */
export function naiveBayesScores(
  model: NaiveBayesModel,
  vec: SparseVector,
): { scores: number[]; coverage: number } {
  const first = model.logLikelihood[0] as Record<number, number>;
  let known = 0;
  let total = 0;
  for (const [feature, value] of vec) {
    total += value;
    if (first[feature] !== undefined) known += value;
  }
  const scores = model.classes.map((_, c) => {
    let s = model.priors[c] as number;
    const table = model.logLikelihood[c] as Record<number, number>;
    for (const [feature, value] of vec) {
      if (first[feature] === undefined) continue;
      s += value * (table[feature] as number);
    }
    return s;
  });
  return { scores, coverage: total === 0 ? 0 : known / total };
}

export function softmaxAt(scores: readonly number[], temperature: number): number[] {
  return softmax(scores.map((s) => s / temperature));
}

export function predictNaiveBayes(model: NaiveBayesModel, vec: SparseVector): Map<string, number> {
  const { scores } = naiveBayesScores(model, vec);
  const probabilities = softmaxAt(scores, model.temperature ?? 1);
  return new Map(model.classes.map((cls, c) => [cls, probabilities[c] as number]));
}

/**
 * Temperature scaling: the T that minimises negative log-likelihood of held-out labels given their
 * held-out scores. A one-parameter fit, so it cannot overfit the way the classifier can, and it
 * changes no prediction — only how sure each one claims to be.
 */
export function fitTemperature(
  heldOut: ReadonlyArray<{ scores: number[]; label: number }>,
): number {
  if (heldOut.length === 0) return 1;
  const nll = (t: number) =>
    heldOut.reduce(
      (sum, { scores, label }) =>
        sum - Math.log(Math.max(softmaxAt(scores, t)[label] as number, 1e-12)),
      0,
    );
  // Coarse log-spaced grid, then refine around the best point. NLL is unimodal in T for this family.
  let best = 1;
  let bestLoss = nll(1);
  for (let t = 1; t <= 4096; t *= 1.25) {
    const loss = nll(t);
    if (loss < bestLoss) [best, bestLoss] = [t, loss];
  }
  for (let t = best / 1.25; t <= best * 1.25; t *= 1.02) {
    const loss = nll(t);
    if (loss < bestLoss) [best, bestLoss] = [t, loss];
  }
  return Math.round(best * 100) / 100;
}

// ─────────────────────────── Binary logistic regression ───────────────────────────

export interface LogisticModel {
  kind: 'logistic';
  weights: Record<number, number>;
  bias: number;
}

export interface LogisticOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  /** Up-weight the positive class; needs labels are rare, and an unweighted model learns "never". */
  positiveWeight?: number;
  seed?: number;
}

/** Deterministic PRNG, so a retrain on the same data yields the same model and the same version hash. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function trainLogistic(
  vectors: readonly SparseVector[],
  targets: readonly (0 | 1)[],
  options: LogisticOptions = {},
): LogisticModel {
  const { epochs = 30, learningRate = 2, l2 = 1e-5, seed = 7 } = options;
  const positives = targets.filter((t) => t === 1).length;
  const positiveWeight =
    options.positiveWeight ??
    (positives > 0 ? Math.min(6, (targets.length - positives) / positives) : 1);

  // A flat typed array over the hashed feature space. Map-based weights made training ~10x slower,
  // and 2^18 doubles is 2 MB — cheap for a model trained once per process.
  const weights = new Float64Array(FEATURE_DIM);
  let bias = 0;
  const order = vectors.map((_, i) => i);
  const random = mulberry32(seed);

  // Pre-compute each vector's index/value arrays and its L2 scale once.
  const prepared = vectors.map((vec) => {
    const indices = Int32Array.from(vec.keys());
    const values = Float64Array.from(vec.values());
    let norm = 0;
    for (const value of values) norm += value * value;
    return { indices, values, scale: norm > 0 ? 1 / Math.sqrt(norm) : 1 };
  });

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    // Fisher–Yates with the seeded PRNG: SGD order matters, and it must be reproducible.
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    // Inputs are L2-normalised, so each feature is ~0.05; the rate has to be large enough for that to
    // move a weight. The first version used 0.2 and underfit to a recall of 0.12.
    const rate = learningRate / (1 + epoch * 0.05);

    for (const i of order) {
      const { indices, values, scale } = prepared[i] as (typeof prepared)[number];
      const target = targets[i] as 0 | 1;

      let z = bias;
      for (let k = 0; k < indices.length; k += 1) {
        z += (weights[indices[k] as number] as number) * (values[k] as number) * scale;
      }
      const error = (sigmoid(z) - target) * (target === 1 ? positiveWeight : 1);

      for (let k = 0; k < indices.length; k += 1) {
        const f = indices[k] as number;
        const w = weights[f] as number;
        weights[f] = w - rate * (error * (values[k] as number) * scale + l2 * w);
      }
      bias -= rate * error * 0.1;
    }
  }

  const out: Record<number, number> = {};
  for (let f = 0; f < weights.length; f += 1) {
    const w = weights[f] as number;
    if (Math.abs(w) > 1e-6) out[f] = w;
  }
  return { kind: 'logistic', weights: out, bias };
}

export function predictLogistic(model: LogisticModel, vec: SparseVector): number {
  let norm = 0;
  for (const value of vec.values()) norm += value * value;
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
  let z = model.bias;
  for (const [feature, value] of vec) z += (model.weights[feature] ?? 0) * value * scale;
  return sigmoid(z);
}
