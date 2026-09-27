import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAnonymityGate,
  DEFAULT_K,
  emptyRawBucket,
  leaksBySubtraction,
  type RawBucket,
} from '../src/anonymity.ts';

function bucket(name: string, n: number, meanMood = 0, meanIntensity = 3): RawBucket {
  return {
    bucket: name,
    n,
    sumMood: n * meanMood,
    sumIntensity: n * meanIntensity,
    histogram: [0, 0, n, 0, 0],
  };
}

function totalOf(buckets: RawBucket[], declined = 0): RawBucket {
  const n = buckets.reduce((a, b) => a + b.n, 0) + declined;
  return {
    bucket: 'all',
    n,
    sumMood: buckets.reduce((a, b) => a + b.sumMood, 0),
    sumIntensity: buckets.reduce((a, b) => a + b.sumIntensity, 0),
    histogram: [0, 0, n, 0, 0],
  };
}

describe('k-anonymity gate', () => {
  test('publishes every bucket when all cohorts are at or above k', () => {
    const buckets = [bucket('18-24', 100), bucket('25-34', 250), bucket('35-44', 80)];
    const { total, buckets: out } = applyAnonymityGate(totalOf(buckets), buckets);
    assert.equal(total.suppressed, false);
    assert.ok(out.every((b) => !b.suppressed));
  });

  test('suppresses the whole slice when the total itself is below k', () => {
    const buckets = [bucket('18-24', 5), bucket('25-34', 6)];
    const { total, buckets: out } = applyAnonymityGate(totalOf(buckets), buckets);
    assert.equal(total.suppressed, true);
    assert.equal(total.suppression_reason, 'below_k');
    assert.ok(out.every((b) => b.suppressed));
    assert.ok(out.every((b) => b.n === 0 && b.histogram === null));
  });

  test('the threshold is inclusive: a cohort of exactly k publishes', () => {
    // No bucket is below k here, so complementary suppression cannot confound the result.
    const buckets = [bucket('at_k', DEFAULT_K), bucket('also_at_k', DEFAULT_K), bucket('big', 500)];
    const { buckets: out } = applyAnonymityGate(totalOf(buckets), buckets);
    assert.ok(out.every((b) => !b.suppressed));
    assert.equal(out.find((b) => b.bucket === 'at_k')?.n, DEFAULT_K);
  });

  test('a cohort of k-1 is withheld, and specifically for being below k', () => {
    const buckets = [bucket('below_k', DEFAULT_K - 1), bucket('a', 500), bucket('b', 500)];
    const { buckets: out } = applyAnonymityGate(totalOf(buckets), buckets);
    assert.equal(out.find((b) => b.bucket === 'below_k')?.suppression_reason, 'below_k');
  });

  test('a bucket at or above k is never withheld for being below k', () => {
    // It may still be withheld as a *complement* — that is a different, disclosed reason, and the
    // distinction matters because it is what tells a reader whether their cohort was too small.
    const buckets = [bucket('at_k', DEFAULT_K), bucket('below_k', DEFAULT_K - 1), bucket('big', 500)];
    const { buckets: out } = applyAnonymityGate(totalOf(buckets), buckets);
    const atK = out.find((b) => b.bucket === 'at_k');
    assert.notEqual(atK?.suppression_reason, 'below_k');
    if (atK?.suppressed) assert.equal(atK.suppression_reason, 'complementary');
  });

  test('a zero-count bucket is published: "nobody here" identifies nobody', () => {
    const buckets = [bucket('none', 0), bucket('a', 200), bucket('b', 300)];
    const { buckets: out } = applyAnonymityGate(totalOf(buckets), buckets);
    assert.equal(out.find((b) => b.bucket === 'none')?.suppressed, false);
    assert.equal(out.find((b) => b.bucket === 'none')?.n, 0);
  });

  test('applies complementary suppression so a lone small bucket is not the only unknown', () => {
    // 5 publishable + 1 tiny. Thresholding alone would leave exactly one unknown.
    const buckets = [
      bucket('18-24', 300),
      bucket('25-34', 400),
      bucket('35-44', 350),
      bucket('45-54', 200),
      bucket('55-64', 150),
      bucket('65+', 3),
    ];
    const { buckets: out } = applyAnonymityGate(totalOf(buckets), buckets);
    const suppressed = out.filter((b) => b.suppressed);
    assert.ok(suppressed.length >= 2, `expected >= 2 suppressed, got ${suppressed.length}`);
    assert.ok(suppressed.some((b) => b.suppression_reason === 'complementary'));
    // The complement chosen is the smallest publishable one: least information lost.
    assert.ok(suppressed.some((b) => b.bucket === '55-64'));
  });

  test('THE SUBTRACTION ATTACK: a suppressed bucket cannot be recovered from the total', () => {
    const buckets = [
      bucket('18-24', 300),
      bucket('25-34', 400),
      bucket('35-44', 350),
      bucket('45-54', 200),
      bucket('55-64', 150),
      bucket('65+', 15), // the number an attacker wants
    ];
    const total = totalOf(buckets);
    const gated = applyAnonymityGate(total, buckets);

    assert.equal(
      leaksBySubtraction(gated.total, gated.buckets),
      false,
      'gate output must not permit recovering a suppressed bucket by subtraction',
    );

    // Demonstrate the attack succeeds against naive thresholding, so the test above is meaningful.
    const naive = {
      total: { ...gated.total, n: total.n },
      buckets: buckets.map((b) =>
        b.n >= DEFAULT_K
          ? { ...gated.buckets[0]!, bucket: b.bucket, n: b.n, suppressed: false }
          : { ...gated.buckets[0]!, bucket: b.bucket, n: 0, suppressed: true },
      ),
    };
    assert.equal(leaksBySubtraction(naive.total, naive.buckets), true);
  });

  test('cascades suppression until the residual is at least k', () => {
    // Two small buckets summing to 4 — hiding them behind each other is not enough.
    const buckets = [bucket('a', 1000), bucket('b', 2), bucket('c', 2)];
    const gated = applyAnonymityGate(totalOf(buckets), buckets);
    assert.equal(leaksBySubtraction(gated.total, gated.buckets), false);
    // 'a' must be pulled in as a complement, because b + c = 4 < k.
    assert.equal(gated.buckets.find((b) => b.bucket === 'a')?.suppressed, true);
  });

  test('quarantined buckets are suppressed and labelled as such', () => {
    const buckets = [bucket('a', 500), bucket('b', 600), bucket('c', 700)];
    const gated = applyAnonymityGate(totalOf(buckets), buckets, {
      quarantined: new Set(['b']),
    });
    const b = gated.buckets.find((x) => x.bucket === 'b');
    assert.equal(b?.suppressed, true);
    assert.equal(b?.suppression_reason, 'quarantined');
  });

  test('never honours a k below the floor, even if a caller asks', () => {
    const buckets = [bucket('tiny', 3), bucket('big', 900)];
    const gated = applyAnonymityGate(totalOf(buckets), buckets, { k: 1 });
    assert.equal(gated.buckets.find((b) => b.bucket === 'tiny')?.suppressed, true);
  });

  test('honours a k raised above the floor', () => {
    const buckets = [bucket('a', 60), bucket('b', 900), bucket('c', 900)];
    const gated = applyAnonymityGate(totalOf(buckets), buckets, { k: 100 });
    assert.equal(gated.buckets.find((b) => b.bucket === 'a')?.suppressed, true);
  });

  test('rounds large counts to the nearest ten to blunt differencing attacks', () => {
    const buckets = [bucket('a', 1234), bucket('b', 5678)];
    const gated = applyAnonymityGate(totalOf(buckets), buckets);
    assert.equal(gated.buckets.find((b) => b.bucket === 'a')?.n, 1230);
    assert.equal(gated.buckets.find((b) => b.bucket === 'b')?.n, 5680);
    // Below the floor, counts are exact.
    const small = [bucket('c', 137), bucket('d', 212)];
    const gatedSmall = applyAnonymityGate(totalOf(small), small);
    assert.equal(gatedSmall.buckets.find((b) => b.bucket === 'c')?.n, 137);
  });

  test('computes means from exact counts, and nulls them for an empty bucket', () => {
    const b = bucket('a', 100, 1.5, 4);
    const gated = applyAnonymityGate(totalOf([b, bucket('z', 900)]), [b, bucket('z', 900)]);
    const out = gated.buckets.find((x) => x.bucket === 'a');
    assert.equal(out?.mean_mood, 1.5);
    assert.equal(out?.mean_intensity, 4);
    const empty = applyAnonymityGate(totalOf([emptyRawBucket('e'), bucket('z', 900)]), [
      emptyRawBucket('e'),
      bucket('z', 900),
    ]);
    assert.equal(empty.buckets.find((x) => x.bucket === 'e')?.mean_mood, null);
  });

  test('handles a dimension with a single bucket without crashing', () => {
    const buckets = [bucket('only', 900)];
    const gated = applyAnonymityGate(totalOf(buckets), buckets);
    assert.equal(gated.buckets[0]?.suppressed, false);
  });

  test('citizens who declined a dimension inflate the total but no bucket', () => {
    const buckets = [bucket('a', 500), bucket('b', 500)];
    const gated = applyAnonymityGate(totalOf(buckets, 300), buckets);
    assert.equal(gated.total.n, 1300);
    assert.ok(gated.buckets.every((b) => !b.suppressed));
  });
});
