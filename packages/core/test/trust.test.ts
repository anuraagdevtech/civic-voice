import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  countsInPublicView,
  detectDeviceCluster,
  detectHomogeneityAnomaly,
  detectPopulationShareViolation,
  detectVelocityAnomaly,
  shouldQuarantine,
  tierDivergence,
  tiersAtOrAbove,
} from '../src/trust.ts';

describe('verification tiers', () => {
  test('the default public view counts identity-verified citizens and above', () => {
    assert.equal(countsInPublicView(0), false);
    assert.equal(countsInPublicView(1), false);
    assert.equal(countsInPublicView(2), true);
    assert.equal(countsInPublicView(3), true);
  });

  test('tiersAtOrAbove enumerates the tiers a query must sum', () => {
    assert.deepEqual(tiersAtOrAbove(2), [2, 3]);
    assert.deepEqual(tiersAtOrAbove(0), [0, 1, 2, 3]);
  });

  test('divergence exposes a gap between the anonymous and verified crowds', () => {
    assert.equal(tierDivergence(-1.8, 0.4), 2.2);
    assert.equal(tierDivergence(0.5, 0.5), 0);
    assert.equal(tierDivergence(null, 0.5), null, 'no divergence claim without both sides');
  });
});

describe('anomaly detection', () => {
  test('velocity is judged against the region’s own baseline, not a global constant', () => {
    const big = { regionId: 1, topicId: 1, observed: 900, baselineMedian: 800, windowSeconds: 300 };
    const small = { regionId: 2, topicId: 1, observed: 900, baselineMedian: 10, windowSeconds: 300 };
    assert.equal(detectVelocityAnomaly(big), null, 'a busy district at its own baseline is normal');
    assert.equal(detectVelocityAnomaly(small)?.severity, 'quarantine');
  });

  test('a cold baseline cannot be exceeded by a factor, so it is floored', () => {
    const cold = { regionId: 3, topicId: 1, observed: 20, baselineMedian: 0, windowSeconds: 300 };
    // 20 against a floor of 5 is 4x — below the watch threshold, so no alarm on a quiet region
    // simply waking up.
    assert.equal(detectVelocityAnomaly(cold), null);
  });

  test('watch and quarantine are distinct severities', () => {
    const w = { regionId: 1, topicId: 1, observed: 100, baselineMedian: 10, windowSeconds: 60 };
    assert.equal(detectVelocityAnomaly(w)?.severity, 'watch');
  });

  test('the population-share ceiling is arithmetic, not statistical', () => {
    assert.equal(detectPopulationShareViolation(1_000, 100_000), null);
    assert.equal(detectPopulationShareViolation(80_000, 100_000)?.severity, 'quarantine');
    assert.equal(detectPopulationShareViolation(5, 0), null, 'unknown population cannot be judged');
  });

  test('implausible uniformity is flagged, genuine spread is not', () => {
    const unanimous = [0, 0, 0, 0, 5_000];
    const realistic = [400, 900, 1_200, 800, 300];
    assert.equal(detectHomogeneityAnomaly(unanimous)?.severity, 'quarantine');
    assert.equal(detectHomogeneityAnomaly(realistic), null);
  });

  test('a small sample is never called uniform: it has no business being judged', () => {
    assert.equal(detectHomogeneityAnomaly([0, 0, 0, 0, 30]), null);
  });

  test('a lopsided but plausible distribution is left alone', () => {
    // A genuinely unpopular policy: mostly angry, but with real spread.
    assert.equal(detectHomogeneityAnomaly([6_000, 2_500, 900, 400, 200]), null);
  });

  test('device clustering escalates with the number of accounts sharing a fingerprint', () => {
    assert.equal(detectDeviceCluster(3), null);
    assert.equal(detectDeviceCluster(15)?.severity, 'watch');
    assert.equal(detectDeviceCluster(200)?.severity, 'quarantine');
  });

  test('only a quarantine-severity finding excludes an aggregate', () => {
    assert.equal(shouldQuarantine([{ kind: 'velocity', severity: 'watch', detail: '' }]), false);
    assert.equal(
      shouldQuarantine([
        { kind: 'velocity', severity: 'watch', detail: '' },
        { kind: 'homogeneity', severity: 'quarantine', detail: '' },
      ]),
      true,
    );
    assert.equal(shouldQuarantine([]), false);
  });
});
