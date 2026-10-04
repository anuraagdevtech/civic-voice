import { useEffect, useState } from 'react';
import { NEED_LABELS, type Digest } from '@civic-voice/sdk';
import { client } from '../api.ts';
import { pct } from '../format.ts';

const TONE: Record<Digest['overall_tone'], string> = {
  mostly_negative: 'Mostly critical',
  mixed: 'Divided',
  mostly_positive: 'Mostly supportive',
  neutral: 'No strong lean',
};

/**
 * What the public thinks, and what it says needs to be done. The shares are counts of per-comment
 * labels; the prose is the large model's summary when one is configured, or quoted suggestions when
 * not — and the card says which, so no one mistakes a summary for a vote.
 */
export function DigestCard({ topicId, refreshKey }: { topicId: number; refreshKey: number }) {
  const [data, setData] = useState<{
    digest: Digest | null;
    comments: number;
    needed: number;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setData(await client.digest(topicId));
      } catch {
        setData(null);
      }
    })();
  }, [topicId, refreshKey]);

  if (!data) return null;
  const { digest } = data;
  if (!digest) {
    return (
      <section className="card digest">
        <h2>What people think</h2>
        <p className="suppressed">
          A summary appears once {data.needed} people have commented — fewer is an anecdote, not a
          view. {data.comments > 0 ? `${data.comments} so far.` : 'Be the first.'}
        </p>
      </section>
    );
  }

  const s = digest.sentiment;
  return (
    <section className="card digest">
      <h2>What people think</h2>
      <p className="meta">
        From {digest.based_on_comments} comments ·{' '}
        {digest.method === 'claude'
          ? `summarised by ${digest.model ?? 'a large language model'}`
          : 'assembled from the comments, no generated text'}
      </p>
      <p className="tone">
        <strong>{TONE[digest.overall_tone]}.</strong> {digest.what_people_think}
      </p>
      <div
        className="split"
        aria-label={`critical ${pct(s.negative)}, neutral ${pct(s.neutral)}, supportive ${pct(s.positive)}`}
      >
        <span style={{ width: pct(s.negative), background: 'var(--mood--2)' }} />
        <span style={{ width: pct(s.neutral), background: 'var(--mood-0)' }} />
        <span style={{ width: pct(s.positive), background: 'var(--mood-2)' }} />
      </div>
      <p className="meta" style={{ margin: 0 }}>
        <span className="sentiment-negative">{pct(s.negative)} critical</span> ·{' '}
        <span className="sentiment-neutral">{pct(s.neutral)} neutral</span> ·{' '}
        <span className="sentiment-positive">{pct(s.positive)} supportive</span>
      </p>

      {digest.needs.length > 0 && (
        <div className="chips" style={{ marginTop: 10 }}>
          {digest.needs.map((n) => (
            <span key={n.need} className="chip">
              {NEED_LABELS[n.need]} · {pct(n.share)}
            </span>
          ))}
        </div>
      )}

      {digest.what_needs_to_be_done.length > 0 && (
        <>
          <h2 style={{ marginTop: 14 }}>What needs to be done, according to residents</h2>
          <ol>
            {digest.what_needs_to_be_done.map((a, i) => (
              <li key={i}>
                {a.action}
                <span className="support">
                  {a.support === 'many'
                    ? 'widely backed'
                    : a.support === 'some'
                      ? 'some backing'
                      : 'raised'}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
