import { useEffect, useState } from 'react';
import type { DocumentKind, DocumentView } from '@civic-voice/sdk';
import { client } from '../api.ts';
import { date, inr, KIND_LABELS } from '../format.ts';

export function SampleBadge({ provenance }: { provenance: string }) {
  if (provenance !== 'sample') return null;
  return (
    <span className="badge sample" title="Development sample: not an official document or figure">
      sample
    </span>
  );
}

/**
 * GOs, projects, notifications and news that concern a region: those scoped anywhere on its path, and
 * those that name it. Each links to its source; a sample document says so.
 */
export function DocumentList({
  regionId,
  kinds,
  limit = 20,
  onOpenTopic,
  emptyText = 'Nothing published for your area yet.',
}: {
  regionId: number;
  kinds?: DocumentKind[];
  limit?: number;
  onOpenTopic: (topicId: number) => void;
  emptyText?: string;
}) {
  const [items, setItems] = useState<DocumentView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const page = await client.documents({
          region_id: regionId,
          ...(kinds ? { kind: kinds } : {}),
          limit,
        });
        setItems(page.items);
        setCursor(page.next_cursor);
      } catch {
        setItems([]);
      }
    })();
  }, [regionId, kinds?.join(','), limit]);

  const more = async () => {
    if (!cursor) return;
    const page = await client.documents({
      region_id: regionId,
      ...(kinds ? { kind: kinds } : {}),
      limit,
      cursor,
    });
    setItems((prev) => [...(prev ?? []), ...page.items]);
    setCursor(page.next_cursor);
  };

  if (items === null) return <p className="suppressed">Loading…</p>;
  if (items.length === 0) return <p className="suppressed">{emptyText}</p>;

  return (
    <div>
      {items.map((d) => (
        <div key={d.id} className="list-item" style={{ cursor: 'default' }}>
          <div className="title">
            {d.go_number && <strong>{d.go_number} · </strong>}
            {d.title}
          </div>
          <div className="sub">
            <span className="badge">{KIND_LABELS[d.kind] ?? d.kind}</span>{' '}
            {d.subject && d.subject !== d.kind && (
              <span className="badge">{KIND_LABELS[d.subject]}</span>
            )}{' '}
            <SampleBadge provenance={d.provenance} /> {d.primary_region_name ?? ''} ·{' '}
            {date(d.published_on)}
            {d.amount_rupees !== null && <> · {inr(d.amount_rupees)}</>}
            {d.vacancies !== null && <> · {d.vacancies.toLocaleString('en-IN')} posts</>}
            {d.department && <> · {d.department}</>}
          </div>
          {d.snippet && d.kind === 'news' && <div className="sub">{d.snippet}</div>}
          <div className="chips" style={{ margin: '6px 0 0' }}>
            <a href={d.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 13 }}>
              {d.provenance === 'sample'
                ? 'Source link (sample — illustrative only)'
                : `Read at ${d.source_name}`}
            </a>
            {d.topic_id !== null && (
              <button className="link" onClick={() => onOpenTopic(d.topic_id as number)}>
                Discuss →
              </button>
            )}
          </div>
        </div>
      ))}
      {cursor && (
        <button className="secondary" onClick={() => void more()}>
          More
        </button>
      )}
    </div>
  );
}
