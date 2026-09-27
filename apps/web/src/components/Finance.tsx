import { Fragment, useEffect, useState } from 'react';
import type { FinanceLine, FinanceResponse, FiscalStage, ReceiptGroup } from '@civic-voice/sdk';
import { client } from '../api.ts';
import { pct } from '../format.ts';
import { SampleBadge } from './Documents.tsx';

/** ₹ crore in the words this audience uses: "₹14.4 lakh crore", "₹99,900 crore". */
export function crore(amount: number): string {
  if (amount >= 100_000)
    return `₹${(amount / 100_000).toLocaleString('en-IN', { maximumFractionDigits: 1 })} lakh crore`;
  return `₹${Math.round(amount).toLocaleString('en-IN')} crore`;
}

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/** A share that rounds to nothing still is something: "<1%", never "0%". */
const share = (x: number) => (x > 0 && x < 0.005 ? '<1%' : pct(x));

/**
 * Each receipt group keeps one colour wherever it appears (colour follows the entity, never its rank),
 * and the stack order keeps yellow and orange apart — the one adjacent pair that fails the
 * colour-vision checks. Validated against this app's own surfaces, in both themes.
 */
const GROUP_ORDER: ReceiptGroup[] = [
  'taxes',
  'from_union',
  'other_own',
  'borrowing',
  'unexplained',
];
const GROUP_CLASS: Record<ReceiptGroup, string> = {
  taxes: 'viz-s1',
  borrowing: 'viz-s2',
  other_own: 'viz-s3',
  from_union: 'viz-s4',
  unexplained: 'viz-unexplained',
};

function change(line: FinanceLine): string | null {
  if (!line.previous || line.previous.amount === 0) return null;
  const d = (line.amount - line.previous.amount) / line.previous.amount;
  const sign = d >= 0 ? '+' : '−';
  return `${sign}${Math.abs(d * 100).toFixed(0)}% on ${line.previous.fy} (${line.previous.stage === 'actual' ? 'actual' : line.previous.stage})`;
}

/** A ranked bar list: magnitude from a zero baseline, value at the tip, details on hover and focus. */
function Bars({
  items,
  total,
  emphasis,
}: {
  items: FinanceLine[];
  total: number;
  /** When set, committed spending is drawn in the de-emphasis grey and programmes in the accent. */
  emphasis?: boolean;
}) {
  const max = Math.max(...items.map((i) => i.amount), 1);
  return (
    <div className="viz-bars" role="list">
      {items.map((i) => {
        const delta = change(i);
        return (
          <div
            key={i.category}
            className="viz-bar-row"
            role="listitem"
            tabIndex={0}
            aria-label={`${i.label}: ${crore(i.amount)}, ${share(i.share)} of ${crore(total)}${delta ? `, ${delta}` : ''}${emphasis && i.committed ? ', committed or passed on' : ''}`}
          >
            <span className="viz-bar-label">{i.label}</span>
            <span className="viz-bar-track">
              <span
                className={`viz-bar ${emphasis && i.committed ? 'viz-muted' : 'viz-s1'}`}
                style={{ width: `${Math.max(0.5, (i.amount / max) * 100)}%` }}
              />
            </span>
            <span className="viz-bar-value">
              {crore(i.amount)} <span className="viz-dim">{share(i.share)}</span>
            </span>
            <span className="viz-tip" role="tooltip">
              <strong>{crore(i.amount)}</strong>
              <span>
                {i.label} · {share(i.share)}
              </span>
              {delta && <span>{delta}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Taxes collected by category, spending by sector, and the gap between them — for the Union and for
 * the citizen's state. The gap is drawn the way budget documents draw it: where each rupee spent came
 * from. Every figure carries its year, its stage and its source; a development sample says so.
 */
export function Finance({
  regionPath,
  regionNames,
}: {
  regionPath: number[];
  regionNames: Record<number, string>;
}) {
  const governments = regionPath.slice(0, 2);
  const [government, setGovernment] = useState<number | undefined>(governments[0]);
  const [choice, setChoice] = useState<{ fy?: string; stage?: FiscalStage }>({});
  const [data, setData] = useState<FinanceResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (government === undefined) return;
    void (async () => {
      try {
        setFailed(false);
        setData(await client.finance(government, choice));
      } catch {
        setFailed(true);
      }
    })();
  }, [government, choice]);

  const s = data?.summary ?? null;
  const name = (id: number, i: number) =>
    `${regionNames[id] ?? (i === 0 ? 'India' : 'Your state')} — ${i === 0 ? 'Union' : 'state'}`;

  return (
    <section className="card">
      <h2>Taxes collected, money spent, and the gap</h2>
      <p className="meta">
        What the government collects in each tax, what it spends on each sector, and how the
        difference is covered.
      </p>

      <div className="chips" role="group" aria-label="Which government">
        {governments.map((id, i) => (
          <button
            key={id}
            className="chip"
            aria-pressed={government === id}
            onClick={() => {
              setGovernment(id);
              setChoice({});
            }}
          >
            {name(id, i)}
          </button>
        ))}
      </div>

      {data && data.available.length > 0 && (
        <label>
          <span className="k">Year and stage</span>
          <br />
          <select
            value={s ? `${s.fy}|${s.stage}` : ''}
            onChange={(e) => {
              const [fy, stage] = e.target.value.split('|');
              setChoice({ fy, stage: stage as FiscalStage });
            }}
          >
            {data.available.flatMap((y) =>
              y.stages.map((st) => (
                <option key={`${y.fy}|${st}`} value={`${y.fy}|${st}`}>
                  {y.fy} —{' '}
                  {st === 'BE' ? 'budget estimate' : st === 'RE' ? 'revised estimate' : 'actual'}
                </option>
              )),
            )}
          </select>
        </label>
      )}

      {failed ? (
        <p className="notice warn">Could not load the public finances. Try again shortly.</p>
      ) : !data ? (
        <p className="suppressed">Loading…</p>
      ) : !s ? (
        <p className="suppressed">
          No published budget figures for {data.region_name} have been loaded yet.
        </p>
      ) : (
        <>
          {s.provenance.includes('sample') && (
            <p className="notice warn">
              <strong>Sample figures.</strong> These are development values of roughly the right
              size, not the published budget. Each links to where the published figure lives.
            </p>
          )}

          <div className="stat-row" style={{ marginTop: 14 }}>
            <div className="stat">
              <div className="n">{crore(s.taxes.total)}</div>
              <div className="k">taxes collected</div>
              {s.taxes.per_capita !== null && (
                <div className="viz-dim">{rupees(s.taxes.per_capita)} per person</div>
              )}
            </div>
            <div className="stat">
              <div className="n">{crore(s.spending.total)}</div>
              <div className="k">spent</div>
              {s.spending.per_capita !== null && (
                <div className="viz-dim">{rupees(s.spending.per_capita)} per person</div>
              )}
            </div>
            <div className="stat">
              <div className="n">{crore(Math.abs(s.gap.amount))}</div>
              <div className="k">
                {s.gap.amount >= 0 ? 'spent beyond taxes' : 'taxes beyond spending'}
              </div>
            </div>
          </div>

          <h3 className="viz-h">Where each rupee spent came from</h3>
          <div className="viz-stack" role="list" aria-label="Where each rupee spent came from">
            {[...s.gap.per_rupee]
              .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
              .map((p, i, all) => (
                <span
                  key={p.group}
                  role="listitem"
                  tabIndex={0}
                  className={`viz-seg ${GROUP_CLASS[p.group]}${i === 0 ? ' first' : ''}${i === all.length - 1 ? ' last' : ''}`}
                  style={{ flexGrow: p.share, flexBasis: 0 }}
                  aria-label={`${p.label}: ${Math.round(p.share * 100)} paise of each rupee, ${crore(p.amount)}`}
                >
                  {/* A label goes inside only where it fits; the legend and tooltip carry the rest. */}
                  {p.share >= 0.12 && (
                    <span className="viz-seg-label">{Math.round(p.share * 100)}p</span>
                  )}
                  <span className="viz-tip" role="tooltip">
                    <strong>
                      <span className="viz-key" aria-hidden="true" />
                      {Math.round(p.share * 100)}p of each rupee
                    </strong>
                    <span>
                      {p.label} · {crore(p.amount)}
                    </span>
                  </span>
                </span>
              ))}
          </div>
          <ul className="viz-legend">
            {[...s.gap.per_rupee]
              .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
              .map((p) => (
                <li key={p.group}>
                  <span className={`viz-swatch ${GROUP_CLASS[p.group]}`} aria-hidden="true" />
                  {p.label}{' '}
                  <span className="viz-dim">
                    {Math.round(p.share * 100)}p · {crore(p.amount)}
                  </span>
                </li>
              ))}
          </ul>
          <p style={{ marginTop: 6 }}>{s.gap.explanation}</p>

          <h3 className="viz-h">Taxes collected, by category</h3>
          <Bars items={s.taxes.items} total={s.taxes.total} />

          <h3 className="viz-h">Money spent, by sector</h3>
          <ul className="viz-legend">
            <li>
              <span className="viz-swatch viz-s1" aria-hidden="true" />
              Programmes and services
            </li>
            <li>
              <span className="viz-swatch viz-muted" aria-hidden="true" />
              Committed or passed on — interest, pensions, other governments
            </li>
          </ul>
          <Bars items={s.spending.items} total={s.spending.total} emphasis />

          <details className="viz-table">
            <summary>Show as a table</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col">₹ crore</th>
                  <th scope="col">Share</th>
                  <th scope="col">Previous year</th>
                </tr>
              </thead>
              <tbody>
                {[['Taxes', s.taxes.items] as const, ['Spending', s.spending.items] as const].map(
                  ([group, rows]) => (
                    <Fragment key={group}>
                      <tr>
                        <th scope="rowgroup" colSpan={4}>
                          {group}
                        </th>
                      </tr>
                      {rows.map((r) => (
                        <tr key={r.category}>
                          <td>{r.label}</td>
                          <td>{Math.round(r.amount).toLocaleString('en-IN')}</td>
                          <td>{share(r.share)}</td>
                          <td>
                            {r.previous
                              ? `${Math.round(r.previous.amount).toLocaleString('en-IN')} (${r.previous.fy} ${r.previous.stage})`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ),
                )}
              </tbody>
            </table>
          </details>

          {s.notes.length > 0 && (
            <ul className="viz-notes">
              {s.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <p className="meta">
            {s.fy}, {s.stage_label.toLowerCase()}. Source:{' '}
            {s.sources.map((src, i) => (
              <span key={src.url}>
                {i > 0 && '; '}
                <a href={src.url} target="_blank" rel="noreferrer noopener">
                  {src.name}
                </a>
              </span>
            ))}{' '}
            {s.provenance.map((p) => (
              <SampleBadge key={p} provenance={p} />
            ))}
          </p>
        </>
      )}
    </section>
  );
}
