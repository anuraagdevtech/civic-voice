import { useEffect, useState } from 'react';
import type { JobsSummary } from '@civic-voice/sdk';
import { client } from '../api.ts';
import { count, date } from '../format.ts';
import { SampleBadge } from './Documents.tsx';

/**
 * "How many government job notifications are there?" — the open ones that apply to you, the posts
 * they state, and what closes soon. A notification that states no number is counted but not guessed,
 * which is why the total is a floor.
 */
export function Jobs({ regionId }: { regionId: number }) {
  const [data, setData] = useState<JobsSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setData(await client.jobs(regionId));
      } catch {
        setFailed(true);
      }
    })();
  }, [regionId]);

  if (failed) return <p className="suppressed">Could not load job notifications.</p>;
  if (!data) return <p className="suppressed">Loading…</p>;

  return (
    <>
      <section className="card">
        <h2>Open government job notifications</h2>
        <p className="meta">
          From recruitment boards and commissions that recruit for where you live, as of{' '}
          {date(data.as_of)}.{data.provenance.includes('sample') && ' Includes sample data.'}
        </p>
        <div className="stat-row">
          <div className="stat">
            <div className="big">{count(data.open_notifications)}</div>
            <div className="k">open notifications</div>
          </div>
          <div className="stat">
            <div className="big">{count(data.stated_vacancies)}+</div>
            <div className="k">posts stated</div>
          </div>
          <div className="stat">
            <div className="big">{count(data.closing_within_7_days)}</div>
            <div className="k">closing within 7 days</div>
          </div>
        </div>
        {data.without_count > 0 && (
          <p className="meta">
            {data.without_count} notification{data.without_count === 1 ? ' does' : 's do'} not state
            a number of posts, so the total is a lower bound.
          </p>
        )}
        {data.by_jurisdiction.length > 0 && (
          <div className="table-scroll">
            <table className="ledger" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>Recruiting for</th>
                  <th className="num">Notifications</th>
                  <th className="num">Posts stated</th>
                </tr>
              </thead>
              <tbody>
                {data.by_jurisdiction.map((j) => (
                  <tr key={j.region_id}>
                    <td>{j.name}</td>
                    <td className="num">{count(j.notifications)}</td>
                    <td className="num">{count(j.vacancies)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Closing soonest first</h2>
        {data.items.length === 0 ? (
          <p className="suppressed">No open notifications right now.</p>
        ) : (
          data.items.map((j) => (
            <div key={j.id} className="list-item" style={{ cursor: 'default' }}>
              <div className="title">{j.title}</div>
              <div className="sub">
                <SampleBadge provenance={j.provenance} /> {j.source_name}
                {j.vacancies !== null && (
                  <>
                    {' '}
                    · <strong>{count(j.vacancies)} posts</strong>
                  </>
                )}
                {j.closing_on && <> · apply by {date(j.closing_on)}</>}
              </div>
              <a href={j.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 13 }}>
                {j.provenance === 'sample'
                  ? 'Notification link (sample — illustrative only)'
                  : 'Official notification'}
              </a>
            </div>
          ))
        )}
      </section>
    </>
  );
}
