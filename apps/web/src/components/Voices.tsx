import { useEffect, useState } from 'react';
import type { CohortId, CohortInsight } from '@civic-voice/sdk';
import { client } from '../api.ts';
import { pct } from '../format.ts';

const COHORTS: Array<{ id: CohortId; label: string; question: string }> = [
  { id: 'youth', label: 'Youth', question: 'What do young people need?' },
  { id: 'farmers', label: 'Farmers', question: 'What do farmers need?' },
  { id: 'women', label: 'Women', question: 'What do women raise?' },
  { id: 'students', label: 'Students', question: 'What do students raise?' },
];

/**
 * What groups of people are saying, where: the needs a cohort raises in its comments, set against
 * everyone's, and its tone. Figures appear only when at least k distinct people contributed, and the
 * page says so rather than showing a small, identifying number.
 */
export function Voices({
  regionPath,
  regionNames,
}: {
  regionPath: number[];
  regionNames: Record<number, string>;
}) {
  const [cohort, setCohort] = useState<CohortId>('youth');
  // The citizen's own city/district level by default: large enough to clear the gate, local enough to mean something.
  const [regionId, setRegionId] = useState<number>(
    regionPath[Math.min(2, regionPath.length - 1)] ?? regionPath[0] ?? 1,
  );
  const [data, setData] = useState<CohortInsight | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setData(await client.cohortInsight(cohort, regionId, 30));
      } catch {
        setData(null);
      }
    })();
  }, [cohort, regionId]);

  const meta = COHORTS.find((c) => c.id === cohort);

  return (
    <>
      <div className="chips" role="group" aria-label="Who">
        {COHORTS.map((c) => (
          <button
            key={c.id}
            className="chip"
            aria-pressed={cohort === c.id}
            onClick={() => setCohort(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Where">
        {regionPath.slice(0, 4).map((id) => (
          <button
            key={id}
            className="chip"
            aria-pressed={regionId === id}
            onClick={() => setRegionId(id)}
          >
            {regionNames[id] ?? `Region ${id}`}
          </button>
        ))}
      </div>

      <section className="card">
        <h2>{meta?.question}</h2>
        {data && (
          <p className="meta">
            {data.label} in {regionNames[regionId] ?? 'this area'}, last {data.window_days} days ·{' '}
            {data.definition}
          </p>
        )}
        {!data ? (
          <p className="suppressed">Loading…</p>
        ) : data.suppressed ? (
          <p className="suppressed">
            Fewer than 25 {data.label.toLowerCase()} here have commented in the last{' '}
            {data.window_days} days, so nothing is shown — a smaller group could identify people.
            Try a larger area.
          </p>
        ) : (
          <>
            <div className="stat-row">
              <div className="stat">
                <div className="big">{data.participants}</div>
                <div className="k">voices</div>
              </div>
              {data.sentiment && (
                <div className="stat">
                  <div className="big sentiment-negative">{pct(data.sentiment.negative)}</div>
                  <div className="k">critical in tone</div>
                </div>
              )}
            </div>
            <h2 style={{ marginTop: 10 }}>What they raise</h2>
            <p className="meta">
              Share of their comments about each need
              {data.comparison ? '; the line marks everyone’s share' : ''}.
            </p>
            {data.needs.slice(0, 8).map((n) => {
              const everyone = data.comparison?.find((c) => c.need === n.need)?.everyone_share;
              return (
                <div key={n.need} className="need-row">
                  <span>{n.label}</span>
                  <div className="track">
                    <div className="fill" style={{ width: pct(n.share) }} />
                    {everyone !== undefined && (
                      <div
                        className="everyone"
                        style={{ left: pct(everyone) }}
                        title={`everyone: ${pct(everyone)}`}
                      />
                    )}
                  </div>
                  <span className="value">{pct(n.share)}</span>
                </div>
              );
            })}
            {!data.comparison && (
              <p className="meta">
                No comparison with everyone: the rest of this area would be a group smaller than 25.
              </p>
            )}
            {data.top_topics.length > 0 && (
              <>
                <h2 style={{ marginTop: 14 }}>Where they are talking</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {data.top_topics.map((t) => (
                    <li key={t.topic_id}>
                      {t.title} <span className="meta">· {t.comments} comments</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="meta" style={{ marginTop: 12 }}>
              {data.method}
            </p>
          </>
        )}
      </section>
    </>
  );
}
