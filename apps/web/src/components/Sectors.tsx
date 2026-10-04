import { useEffect, useState } from 'react';
import {
  DEMOGRAPHIC_DIMENSIONS,
  type DemographicDimension,
  type MoodBucket,
  type SectorInsight,
  type SectorInsightRow,
} from '@civic-voice/sdk';
import { client } from '../api.ts';
import { pct } from '../format.ts';
import { crore } from './Finance.tsx';
import { SampleBadge } from './Documents.tsx';

const DIMENSION_LABELS: Record<DemographicDimension, string> = {
  age_band: 'Age',
  gender: 'Gender',
  urbanity: 'Urban / rural',
  income_band: 'Income',
  education_band: 'Education',
  occupation_band: 'Occupation',
  employment_status: 'Employment',
};

const mood = (b: MoodBucket) =>
  b.suppressed || b.mean_mood === null
    ? '—'
    : `${b.mean_mood > 0 ? '+' : b.mean_mood < 0 ? '−' : ''}${Math.abs(b.mean_mood).toFixed(2)}`;

const share = (x: number | null) => (x === null ? 'withheld' : x > 0 && x < 0.005 ? '<1%' : pct(x));

/**
 * One sector as a dumbbell on a shared 0–max share axis: its share of programme spending (blue) and
 * its share of what residents raise (orange). Two measures in the same unit on one axis — no second
 * scale, so the distance between the dots is the finding.
 */
function Dumbbell({ row, max }: { row: SectorInsightRow; max: number }) {
  const s = row.spending.share_of_programmes;
  const a = row.attention.share;
  const x = (v: number) => `${(v / max) * 100}%`;
  const label = `${row.label}: ${share(s)} of programme spending, ${share(a)} of what residents raise`;
  return (
    <div className="viz-bar-row viz-dumbbell" role="listitem" tabIndex={0} aria-label={label}>
      <span className="viz-bar-label">{row.label}</span>
      <span className="viz-dumb-track">
        {s !== null && a !== null && (
          <span
            className="viz-dumb-link"
            style={{ left: x(Math.min(s, a)), width: `${(Math.abs(s - a) / max) * 100}%` }}
          />
        )}
        {s !== null && <span className="viz-dot viz-s1" style={{ left: x(s) }} />}
        {a !== null && <span className="viz-dot viz-s2" style={{ left: x(a) }} />}
      </span>
      <span className="viz-bar-value">
        {row.attention_minus_spending === null
          ? '—'
          : `${row.attention_minus_spending > 0 ? '+' : '−'}${Math.abs(row.attention_minus_spending * 100).toFixed(0)} pts`}
      </span>
      <span className="viz-tip" role="tooltip">
        <strong>
          {a === null ? 'Raised: withheld' : `${share(a)} raised`} ·{' '}
          {s === null ? 'no budget line' : `${share(s)} funded`}
        </strong>
        <span>{row.label}</span>
        <span>
          {row.spending.amount !== null ? crore(row.spending.amount) : 'no budget line'}
          {row.attention.voices !== null ? ` · ${row.attention.voices} voices` : ''}
        </span>
      </span>
    </div>
  );
}

/**
 * For researchers: a government's programme spending set against what its residents raise and how
 * they feel about its decisions, sector by sector. Every figure is k-gated on the server; this only
 * draws what was published, says what was withheld, and exports the same thing as CSV.
 */
export function Sectors({
  regionPath,
  regionNames,
}: {
  regionPath: number[];
  regionNames: Record<number, string>;
}) {
  const governments = regionPath.slice(0, 2);
  const [government, setGovernment] = useState<number | undefined>(governments[0]);
  const [dimension, setDimension] = useState<DemographicDimension | ''>('');
  const [days, setDays] = useState(90);
  const [unverified, setUnverified] = useState(false);
  const [data, setData] = useState<SectorInsight | null>(null);
  const [failed, setFailed] = useState(false);

  const opts = {
    days,
    ...(dimension ? { dimension } : {}),
    ...(unverified ? { tier: 0 as const } : {}),
  };

  useEffect(() => {
    if (government === undefined) return;
    void (async () => {
      try {
        setFailed(false);
        setData(await client.sectorInsight(government, opts));
      } catch {
        setFailed(true);
      }
    })();
  }, [government, dimension, days, unverified]);

  const rows = data?.sectors ?? [];
  const drawn = rows.filter(
    (r) => r.spending.share_of_programmes !== null || r.attention.share !== null,
  );
  const max = Math.max(
    0.05,
    ...drawn.flatMap((r) => [r.spending.share_of_programmes ?? 0, r.attention.share ?? 0]),
  );
  const buckets = [...new Set(rows.flatMap((r) => r.mood.buckets.map((b) => b.bucket)))];

  return (
    <section className="card">
      <h2>Opinion against allocation</h2>
      <p className="meta">
        For each sector: its share of the government’s programme spending, its share of what
        residents raise, and their mood on the government’s own decisions there. For researchers —
        associations, not causes.
      </p>

      <div className="chips" role="group" aria-label="Which government">
        {governments.map((id, i) => (
          <button
            key={id}
            className="chip"
            aria-pressed={government === id}
            onClick={() => setGovernment(id)}
          >
            {regionNames[id] ?? (i === 0 ? 'India' : 'Your state')} — {i === 0 ? 'Union' : 'state'}
          </button>
        ))}
      </div>
      <div className="stat-row">
        <label>
          <span className="k">Mood by</span>
          <br />
          <select
            value={dimension}
            onChange={(e) => setDimension(e.target.value as DemographicDimension | '')}
          >
            <option value="">Everyone</option>
            {DEMOGRAPHIC_DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {DIMENSION_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="k">Comments from the last</span>
          <br />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="viz-check">
          <input
            type="checkbox"
            checked={unverified}
            onChange={(e) => setUnverified(e.target.checked)}
          />{' '}
          Count unverified opinions too
        </label>
      </div>

      {failed ? (
        <p className="notice warn">Could not load the sector figures. Try again shortly.</p>
      ) : !data ? (
        <p className="suppressed">Loading…</p>
      ) : (
        <>
          <ul className="viz-legend">
            <li>
              <span className="viz-swatch viz-s1 round" aria-hidden="true" />
              Share of programme spending{data.fy ? ` (${data.fy})` : ''}
            </li>
            <li>
              <span className="viz-swatch viz-s2 round" aria-hidden="true" />
              Share of what residents raise (last {data.window_days} days)
            </li>
          </ul>
          {drawn.length === 0 ? (
            <p className="suppressed">
              Nothing to compare yet: no budget figures loaded and no sector clears the privacy
              threshold.
            </p>
          ) : (
            <div className="viz-bars" role="list">
              {drawn.map((r) => (
                <Dumbbell key={r.sector} row={r} max={max} />
              ))}
            </div>
          )}

          <details className="viz-table" open>
            <summary>Sector table</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">Sector</th>
                  <th scope="col">Spending</th>
                  <th scope="col">Raised</th>
                  <th scope="col">Critical</th>
                  <th scope="col">Mood</th>
                  {buckets.map((b) => (
                    <th key={b} scope="col">
                      {b.replace(/_/g, ' ')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sector}>
                    <td>{r.label}</td>
                    <td>{share(r.spending.share_of_programmes)}</td>
                    <td>{share(r.attention.share)}</td>
                    <td>
                      {r.attention.suppressed
                        ? 'withheld'
                        : r.attention.negative_share === null
                          ? '—'
                          : share(r.attention.negative_share)}
                    </td>
                    <td
                      title={`${r.mood.topics_counted} of ${r.mood.topics} decisions had enough opinions to count`}
                    >
                      {mood(r.mood.total)}
                      {!r.mood.total.suppressed && (
                        <span className="viz-dim"> · {r.mood.total.n}</span>
                      )}
                    </td>
                    {buckets.map((b) => {
                      const cell = r.mood.buckets.find((x) => x.bucket === b);
                      return (
                        <td key={b} title={cell?.suppressed ? 'withheld: too few people' : ''}>
                          {cell ? mood(cell) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="meta">
              Mood is the mean on a −2 (angry) to +2 (satisfied) scale; “—” is withheld because
              fewer than {data.k} people are behind it. Verification tier {data.tier} and above.
            </p>
          </details>

          {data.unmapped.some((u) => u.comments) && (
            <p className="meta">
              Also raised, with no budget head of its own:{' '}
              {data.unmapped
                .filter((u) => u.comments)
                .map((u) => `${u.label.toLowerCase()} (${u.comments} comments)`)
                .join(', ')}
              .
            </p>
          )}

          <ul className="viz-notes">
            {data.method.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="meta">
            <a
              href={client.sectorInsightCsvUrl(data.region_id, opts)}
              download
              rel="noreferrer noopener"
            >
              Download as CSV
            </a>{' '}
            {data.sources.map((s) => (
              <span key={s.url}>
                · Spending source:{' '}
                <a href={s.url} target="_blank" rel="noreferrer noopener">
                  {s.name}
                </a>{' '}
              </span>
            ))}
            {data.provenance.map((p) => (
              <SampleBadge key={p} provenance={p} />
            ))}
          </p>
        </>
      )}
    </section>
  );
}
