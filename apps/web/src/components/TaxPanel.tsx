import { useEffect, useState } from 'react';
import type { TaxUtilisationView } from '@civic-voice/sdk';
import { client } from '../api.ts';

/** Indian numbering, because ₹1,20,00,000 is what this audience reads. */
const inr = (n: number | null): string => {
  if (n === null) return '—';
  if (n >= 1e7) return `₹${(n / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 1 })} cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 })} lakh`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

export function TaxPanel({ regionId, regionName }: { regionId: number; regionName: string }) {
  const [view, setView] = useState<TaxUtilisationView | null>(null);
  const [fy, setFy] = useState('2026-27');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setError(null);
      try {
        setView(await client.taxUtilisation(regionId, fy));
      } catch {
        setError('Could not load the spending figures for this area.');
      }
    })();
  }, [regionId, fy]);

  return (
    <section className="card">
      <h2>Where the money went — {regionName}</h2>
      <p className="meta">
        Allocated, released and actually spent, per scheme — across your constituency, district and
        state. Every figure links to the document it came from.
      </p>

      <label>
        <span className="k">Financial year</span>
        <br />
        <select value={fy} onChange={(e) => setFy(e.target.value)}>
          {['2026-27', '2025-26', '2024-25'].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="notice warn">{error}</p>}

      {view === null ? (
        <p className="suppressed">Loading…</p>
      ) : view.lines.length === 0 ? (
        <p className="suppressed">No published figures for this area and year yet.</p>
      ) : (
        <>
          <div className="stat-row" style={{ marginTop: 14 }}>
            <div className="stat">
              <div className="n">{inr(view.totals.allocated_be)}</div>
              <div className="k">allocated</div>
            </div>
            <div className="stat">
              <div className="n">{inr(view.totals.utilised)}</div>
              <div className="k">spent</div>
            </div>
            <div className="stat">
              <div className="n">
                {view.totals.utilisation_rate === null
                  ? '—'
                  : `${(view.totals.utilisation_rate * 100).toFixed(0)}%`}
              </div>
              <div className="k">of released</div>
            </div>
            <div className="stat">
              <div className="n">{view.lines.length}</div>
              <div className="k">schemes</div>
            </div>
          </div>

          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Scheme</th>
                  <th>Level</th>
                  <th className="num">Allocated</th>
                  <th className="num">Spent</th>
                  <th className="num">Of released</th>
                  <th className="num">Per person</th>
                  <th className="num">Mood</th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      {line.source_refs[0] ? (
                        <a href={line.source_refs[0]} target="_blank" rel="noreferrer noopener">
                          {line.scheme_name}
                        </a>
                      ) : (
                        line.scheme_name
                      )}
                    </td>
                    <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                      {line.region_name ?? line.level}
                    </td>
                    <td className="num">{inr(line.allocated_be)}</td>
                    <td className="num">{inr(line.utilised)}</td>
                    <td className="num">
                      {line.utilisation_rate === null
                        ? '—'
                        : `${(line.utilisation_rate * 100).toFixed(0)}%`}
                    </td>
                    <td className="num">{inr(line.per_capita_utilised)}</td>
                    <td className="num">{line.mean_mood?.toFixed(2) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="suppressed" style={{ marginTop: 12 }}>
            Spending is published at whichever level administers it, so these figures span your
            constituency, district and state — the “Level” column says which. “Of released” compares
            spending against money that actually arrived, not against the estimate: 80% of a
            half-funded scheme is not 80% of the promise. Per-person figures use the population of
            the level the money belongs to. A mood figure is shown only where at least 25 verified
            people responded.
          </p>
        </>
      )}
    </section>
  );
}
