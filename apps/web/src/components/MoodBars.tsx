import { MOOD_LABELS, type MoodAggregate, type MoodBucket } from '@civic-voice/sdk';

/**
 * A published mood distribution.
 *
 * Two rules the UI must not break, both from docs/PRIVACY.md:
 *
 *  - A suppressed bucket is shown *as suppressed*, with the reason. Hiding the row would make the
 *    reader think the cohort does not exist; showing a zero would be a lie.
 *  - Staleness is disclosed. A number that admits being 30 seconds old is fine; one that implies it
 *    is live is not.
 */
const MOOD_ORDER = [-2, -1, 0, 1, 2] as const;

function bucketLabel(bucket: string): string {
  return bucket === 'all' ? 'Everyone' : bucket.replace(/_/g, ' ');
}

function suppressionText(reason: MoodBucket['suppression_reason']): string {
  switch (reason) {
    case 'below_k':
      return 'withheld — fewer than 25 people';
    case 'complementary':
      return 'withheld — would reveal a smaller group';
    case 'quarantined':
      return 'withheld — flagged as anomalous';
    default:
      return 'withheld';
  }
}

export function MoodHistogram({ bucket }: { bucket: MoodBucket }) {
  if (bucket.suppressed || bucket.histogram === null) {
    return <p className="suppressed">{suppressionText(bucket.suppression_reason)}</p>;
  }
  const total = bucket.histogram.reduce((a, b) => a + b, 0);
  return (
    <div className="bars">
      {MOOD_ORDER.map((mood) => {
        const count = bucket.histogram?.[mood + 2] ?? 0;
        const share = total > 0 ? (count / total) * 100 : 0;
        return (
          <div className="bar-row" key={mood}>
            <span className="label">{MOOD_LABELS[mood]}</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: `${share}%`, background: `var(--mood-${mood})` }}
                role="img"
                aria-label={`${MOOD_LABELS[mood]}: ${share.toFixed(0)} percent`}
              />
            </div>
            <span className="value">{share.toFixed(0)}%</span>
          </div>
        );
      })}
    </div>
  );
}

export function DimensionBreakdown({ aggregate }: { aggregate: MoodAggregate }) {
  return (
    <div className="bars">
      {aggregate.buckets.map((bucket) => {
        if (bucket.suppressed) {
          return (
            <div className="bar-row" key={bucket.bucket}>
              <span className="label">{bucketLabel(bucket.bucket)}</span>
              <span className="suppressed">{suppressionText(bucket.suppression_reason)}</span>
              <span className="value">—</span>
            </div>
          );
        }
        // Mean mood on a −2..+2 scale, mapped onto a 0..100% bar with the neutral point at the middle.
        const mean = bucket.mean_mood ?? 0;
        const position = ((mean + 2) / 4) * 100;
        const nearest = Math.max(-2, Math.min(2, Math.round(mean)));
        return (
          <div className="bar-row" key={bucket.bucket}>
            <span className="label">{bucketLabel(bucket.bucket)}</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: `${position}%`, background: `var(--mood-${nearest})` }}
                role="img"
                aria-label={`${bucketLabel(bucket.bucket)}: mean mood ${mean.toFixed(2)}`}
              />
            </div>
            <span className="value">{bucket.n.toLocaleString('en-IN')}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AggregateFooter({ aggregate }: { aggregate: MoodAggregate }) {
  return (
    <>
      <div className="stat-row">
        <div className="stat">
          <div className="n">
            {aggregate.total.suppressed ? '—' : aggregate.total.n.toLocaleString('en-IN')}
          </div>
          <div className="k">people</div>
        </div>
        <div className="stat">
          <div className="n">{aggregate.total.mean_mood?.toFixed(2) ?? '—'}</div>
          <div className="k">mean mood</div>
        </div>
        <div className="stat">
          <div className="n">T{aggregate.tier}+</div>
          <div className="k">verification</div>
        </div>
      </div>

      {aggregate.tier_divergence !== null && aggregate.tier_divergence > 0.8 && (
        <p className="notice warn">
          <strong>Unverified responses diverge sharply</strong> from verified ones on this topic (a
          gap of {aggregate.tier_divergence.toFixed(2)} on a 4-point scale). That can mean a
          coordinated push, or simply that different groups took part. The figures above count
          identity-verified citizens only.
        </p>
      )}

      <p className="suppressed">
        Updated {aggregate.staleness_seconds}s ago. Figures for groups of fewer than 25 people are
        withheld, so that no individual can be identified from them.
      </p>
    </>
  );
}
