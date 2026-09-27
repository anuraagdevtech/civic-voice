# 0011 — An in-house model on every comment; a large model only where it is unsure

**Status:** Accepted

## Context
"What does the public think, what do youth need, what do farmers need" means labelling every
comment — sentiment, which needs it raises, whether it proposes something — in English, Hindi,
Telugu and their romanised forms. At the modelled spike that is ~7,000 comments a second. A large
language model on every comment would be the most accurate and the most expensive option, and would
put the platform's core function behind a third-party dependency.

## Decision
- **Every comment is labelled in-process** by a small model trained at startup from a bundled,
  versioned dataset: character and word n-grams, multinomial naive Bayes for sentiment, logistic
  regression and a multilingual lexicon for 14 needs, a suggestion detector. 0.68 ms per comment; the
  model version is a hash of its inputs and is stored on every label.
- **Its confidence is calibrated.** Naive Bayes over overlapping n-grams claims near-certainty on
  everything; a temperature fitted on held-out folds brings held-out expected calibration error from
  0.228 to 0.050. Comments below 0.6 confidence, or with less than half their features known to the
  model, are flagged.
- **Flagged comments are escalated** to a large model (Claude), in batches of 20, with the comments
  as delimited data, schema-constrained output, and server-side fallback enabled — within a per-pod
  **budget** (`CIVIC_ESCALATIONS_PER_MINUTE`). Held-out, flagged comments are wrong 45% of the time
  and trusted ones 14%, so the flag is where the money is best spent. Any failure keeps the in-house
  labels.
- **Digests** ("what people think, what needs to be done") are written by the large model when one is
  configured, and assembled extractively otherwise — but their *figures* are always computed from
  per-comment labels, never from the model's prose, and every digest says which method made it.

## What we gave up
- **The measured accuracy is on 241 seed examples,** by 5-fold cross-validation: sentiment macro-F1
  0.62 (majority baseline 0.27), needs micro-F1 0.79. It is *not* an estimate of accuracy on real
  forum traffic, and the report says so. Real traffic needs a labelled sample and re-evaluation.
- **The learned needs classifier is weak** (micro-F1 ~0.27 alone); the lexicon does most of the
  work, and the learned half only fires above 0.8.
- **At a spike the budget, not the traffic, decides** how many uncertain comments get the better
  label: ~100/s against ~2,250/s wanted. Aggregates during a spike lean more on the in-house model.
- **Public comments are sent to a third-party API** when a key is configured. They are already
  public and personal information is refused before acceptance, but it is still a processor, and a
  deployment must list it as one.
