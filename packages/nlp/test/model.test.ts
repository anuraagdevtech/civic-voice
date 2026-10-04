import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze,
  evaluate,
  loadSeedDataset,
  moderate,
  moodFromSentiment,
  parseDataset,
  trainSeedModel,
  type EvaluationReport,
  type TrainedModel,
} from '../src/index.ts';

describe('seed dataset', () => {
  test('parses, and every label is from the closed vocabularies', () => {
    const data = loadSeedDataset();
    assert.ok(data.length >= 200, `expected a seed set of useful size, got ${data.length}`);
  });

  test('covers every language variant the pipeline claims to handle', () => {
    const scripts = { devanagari: 0, telugu: 0, latin: 0 };
    for (const e of loadSeedDataset()) {
      if (/[ऀ-ॿ]/.test(e.text)) scripts.devanagari += 1;
      else if (/[ఀ-౿]/.test(e.text)) scripts.telugu += 1;
      else scripts.latin += 1;
    }
    assert.ok(
      scripts.devanagari >= 25 && scripts.telugu >= 25 && scripts.latin >= 100,
      JSON.stringify(scripts),
    );
  });

  test('rejects an unknown need or sentiment rather than silently training on it', () => {
    assert.throws(() => parseDataset('{"t":"x","s":-1,"n":["rockets"],"g":0}'), /unknown need/);
    assert.throws(() => parseDataset('{"t":"x","s":5,"n":[],"g":0}'), /bad sentiment/);
  });
});

describe('cross-validated evaluation', () => {
  let report: EvaluationReport;
  before(() => {
    report = evaluate(loadSeedDataset(), 5);
  });

  // These assert *relationships* the design depends on, not specific numbers. A number would pass or
  // fail on noise; a relationship failing means the design assumption behind a component is wrong.

  test('sentiment beats the majority-class baseline decisively on macro-F1', () => {
    assert.ok(
      report.sentiment.macroF1 > report.sentiment.majorityBaseline.macroF1 + 0.2,
      `macro-F1 ${report.sentiment.macroF1} vs baseline ${report.sentiment.majorityBaseline.macroF1}`,
    );
  });

  test('sentiment also beats the baseline on accuracy, which it did not before the OOV fix', () => {
    assert.ok(
      report.sentiment.accuracy > report.sentiment.majorityBaseline.accuracy,
      `accuracy ${report.sentiment.accuracy} vs baseline ${report.sentiment.majorityBaseline.accuracy}`,
    );
  });

  test('REGRESSION: native-script Hindi and Telugu are well above chance', () => {
    // Before out-of-vocabulary n-grams were dropped, Devanagari scored 26% — below chance for three
    // classes — because every unseen n-gram pushed toward the smallest class.
    const hi = report.sentiment.byLanguage['hi'];
    const te = report.sentiment.byLanguage['te'];
    assert.ok(hi && hi.accuracy > 0.5, `Hindi accuracy ${hi?.accuracy}`);
    assert.ok(te && te.accuracy > 0.5, `Telugu accuracy ${te?.accuracy}`);
  });

  test('the needs ensemble is at least as good as either component alone', () => {
    const { ensemble, learnedOnly, lexiconOnly } = report.needs;
    assert.ok(
      ensemble.microF1 >= lexiconOnly.microF1 - 0.005,
      `ensemble ${ensemble.microF1} < lexicon ${lexiconOnly.microF1}`,
    );
    assert.ok(
      ensemble.microF1 > learnedOnly.microF1,
      `ensemble ${ensemble.microF1} <= learned ${learnedOnly.microF1}`,
    );
  });

  test('the suggestion ensemble beats both of its components', () => {
    const { ensemble, learnedOnly, lexiconOnly } = report.suggestion;
    assert.ok(
      ensemble.f1 > learnedOnly.f1 && ensemble.f1 > lexiconOnly.f1,
      JSON.stringify(report.suggestion),
    );
  });

  test('the report carries its own caveat, so a number cannot be quoted without it', () => {
    assert.match(report.caveat, /NOT an estimate of accuracy on real forum traffic/);
  });
});

describe('comment analysis', () => {
  let model: TrainedModel;
  before(() => {
    model = trainSeedModel();
  });

  test('training is deterministic, so the version identifies the model exactly', () => {
    assert.equal(trainSeedModel().version, model.version);
    assert.match(model.version, /^nb-lr-[0-9a-f]{12}$/);
  });

  test('reads a clear English complaint', () => {
    const a = analyze(model, 'No water supply in our colony for five days, we are buying tankers');
    assert.equal(a.sentiment.label, 'negative');
    assert.ok(a.needs.some((n) => n.need === 'water'));
    assert.equal(a.moderation.verdict, 'allow');
  });

  test('reads a Telugu farmers’ demand as agriculture, and as a suggestion', () => {
    const a = analyze(model, 'రైతులకు మద్దతు ధర ఇవ్వాలి, పంట కొనుగోలు వెంటనే చేయాలి');
    assert.equal(a.language, 'te');
    assert.ok(
      a.needs.some((n) => n.need === 'agriculture'),
      JSON.stringify(a.needs),
    );
    assert.equal(a.suggestion.value, true);
  });

  test('reads romanised Hindi about jobs', () => {
    const a = analyze(model, 'yuvaon ko naukri chahiye, berozgari bahut hai');
    assert.equal(a.language, 'hi-Latn');
    assert.ok(
      a.needs.some((n) => n.need === 'employment'),
      JSON.stringify(a.needs),
    );
  });

  test('reads appreciation as positive', () => {
    const a = analyze(model, 'Metro extension is a great decision, travel is so much easier now');
    assert.equal(a.sentiment.label, 'positive');
    assert.ok(a.mood > 0);
  });

  test('stamps every analysis with the model version that produced it', () => {
    assert.equal(analyze(model, 'roads are bad').modelVersion, model.version);
  });

  test('a comment with no need attached reports none rather than guessing one', () => {
    const a = analyze(model, 'I will read the order and comment later');
    assert.deepEqual(a.needs, []);
  });

  test('flags a hesitant prediction for escalation instead of trusting it', () => {
    // A vague one-word comment should not come back as confident either way.
    const a = analyze(model, 'hmm');
    assert.equal(a.lowConfidence, true);
  });

  test('maps sentiment strength onto the five-point mood scale', () => {
    assert.equal(moodFromSentiment('negative', 0.95), -2);
    assert.equal(moodFromSentiment('negative', 0.6), -1);
    assert.equal(moodFromSentiment('neutral', 0.99), 0);
    assert.equal(moodFromSentiment('positive', 0.7), 1);
    assert.equal(moodFromSentiment('positive', 0.9), 2);
  });
});

describe('moderation', () => {
  test('rejects PII outright and says which kind', () => {
    const r = moderate('my pension stopped, call 9876543210');
    assert.equal(r.verdict, 'reject');
    assert.ok(r.reasons.includes('pii'));
    assert.equal(r.pii[0]?.kind, 'phone');
  });

  test('holds threats for a human rather than deleting them automatically', () => {
    for (const text of ['they should kill them all', 'इन लोगों को मार डालो', 'వాళ్ళని చంపేయండి']) {
      const r = moderate(text);
      assert.equal(r.verdict, 'hold', text);
      assert.ok(r.reasons.includes('threat'), text);
    }
  });

  test('holds personal abuse for review', () => {
    assert.equal(moderate('the officer is an idiot').verdict, 'hold');
  });

  test('holds link floods and copy-paste repetition as spam', () => {
    assert.equal(moderate('see http://a.co http://b.co http://c.co now').verdict, 'hold');
    assert.equal(moderate('vote vote vote vote vote vote vote vote vote').verdict, 'hold');
  });

  test('allows angry but legitimate criticism — anger is not abuse', () => {
    for (const text of [
      'This is a complete failure of the government and a waste of public money',
      'ప్రభుత్వం పూర్తిగా విఫలమైంది, ప్రజాధనం వృధా',
      'sarkar bilkul nakami hai, kuch kaam nahi hota',
    ]) {
      assert.equal(moderate(text).verdict, 'allow', text);
    }
  });

  test('shouting is recorded but not acted on', () => {
    const r = moderate('THE ROADS IN OUR AREA ARE COMPLETELY DESTROYED PLEASE FIX THEM');
    assert.equal(r.verdict, 'allow');
    assert.ok(r.reasons.includes('shouting'));
  });

  test('rejects an empty or near-empty comment', () => {
    assert.equal(moderate(' . ').verdict, 'reject');
  });
});

describe('lexicon inflections', () => {
  test('English inflections reach the base form', async () => {
    const { latinVariants, lexiconNeeds } = await import('../src/needs.ts');
    assert.ok(latinVariants('floods').includes('flood'));
    assert.ok(latinVariants('flooded').includes('flood'));
    assert.ok(latinVariants('stopped').includes('stop'));
    assert.ok(latinVariants('delayed').includes('delay'));
    assert.deepEqual(latinVariants('bus'), ['bus'], 'short words are left alone');
    assert.ok(
      lexiconNeeds(['underpass', 'floods', 'every', 'year'], 'underpass floods every year').has(
        'sanitation',
      ),
    );
  });
});
