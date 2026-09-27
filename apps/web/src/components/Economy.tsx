import { useEffect, useState } from 'react';
import type { Indicator } from '@civic-voice/sdk';
import { client } from '../api.ts';
import { SampleBadge } from './Documents.tsx';

const CATEGORY: Record<Indicator['category'], string> = {
  public_finance: 'How much money there is — budgets, deficits, debt',
  economy: 'Prices',
  jobs: 'Work',
  agriculture: 'Farming',
};

function value(i: { value: number }, unit: string): string {
  if (unit === '%') return `${i.value.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`;
  if (unit.startsWith('₹ crore')) return `₹${i.value.toLocaleString('en-IN')} crore`;
  if (unit.startsWith('₹'))
    return `₹${i.value.toLocaleString('en-IN')} ${unit.replace('₹', '').trim()}`;
  return `${i.value.toLocaleString('en-IN')} ${unit}`;
}

/**
 * Socio-economic indicators for every level you live in. Each figure names its source and period; a
 * development sample says so on the figure itself.
 */
export function Economy({ regionId }: { regionId: number }) {
  const [items, setItems] = useState<Indicator[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setItems((await client.indicators(regionId)).items);
      } catch {
        setItems([]);
      }
    })();
  }, [regionId]);

  if (items === null) return <p className="suppressed">Loading…</p>;
  if (items.length === 0)
    return <p className="suppressed">No indicators loaded for your area yet.</p>;

  // Public finances first: "how much money is there" is the question this page answers first.
  const ORDER: Indicator['category'][] = ['public_finance', 'economy', 'jobs', 'agriculture'];
  const categories = ORDER.filter((c) => items.some((i) => i.category === c));
  return (
    <>
      {items.some((i) => i.provenance === 'sample') && (
        <p className="notice warn">
          <strong>Sample figures.</strong> The values marked “sample” are development placeholders
          of roughly the right size, not official statistics. Each links to where the published
          figure lives.
        </p>
      )}
      {categories.map((cat) => (
        <section key={cat} className="card">
          <h2>{CATEGORY[cat]}</h2>
          {items
            .filter((i) => i.category === cat)
            .map((i) => (
              <div
                key={`${i.code}:${i.region_id}`}
                className="list-item"
                style={{ cursor: 'default' }}
              >
                <div className="title">
                  {i.name} — {i.region_name}
                </div>
                <div className="stat-row" style={{ margin: '6px 0' }}>
                  <div className="stat">
                    <div className="n">{value(i, i.unit)}</div>
                    <div className="k">{i.period}</div>
                  </div>
                  {i.previous && (
                    <div className="stat">
                      <div className="n" style={{ color: 'var(--text-dim)' }}>
                        {value(i.previous, i.unit)}
                      </div>
                      <div className="k">{i.previous.period}</div>
                    </div>
                  )}
                </div>
                <div className="sub">
                  <SampleBadge provenance={i.provenance} />{' '}
                  <a href={i.source_url} target="_blank" rel="noreferrer noopener">
                    {i.source_name}
                  </a>
                </div>
              </div>
            ))}
        </section>
      ))}
    </>
  );
}
