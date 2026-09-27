import { useEffect, useState } from 'react';
import { newWriteKey, type Topic } from '@civic-voice/sdk';
import { CivicApiError, client } from '../api.ts';
import { KIND_LABELS } from '../format.ts';
import { DocumentList } from './Documents.tsx';

const FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Everything' },
  { id: 'local_issue', label: 'Local issues' },
  { id: 'government_order', label: 'GOs' },
  { id: 'project', label: 'Projects' },
  { id: 'scheme', label: 'Schemes' },
  { id: 'news', label: 'News' },
  { id: 'policy', label: 'Policies' },
];

function RaiseIssue({ onRaised }: { onRaised: (topic: Topic) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [scope, setScope] = useState<'ward' | 'city' | 'district' | 'state'>('ward');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newWriteKey);

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        + Raise a local issue
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const topic = await client.raiseIssue({ title, details, scope }, key);
      setKey(newWriteKey());
      setOpen(false);
      setTitle('');
      setDetails('');
      onRaised(topic);
    } catch (err) {
      setError(
        err instanceof CivicApiError ? err.message : 'Could not raise the issue. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Raise a local issue</h2>
      <p className="meta">
        Something in your ward or city that needs fixing. Residents of the area you choose can
        discuss it and say what should be done. Public; no names, phone numbers or ID numbers.
      </p>
      <label>
        <span className="k">Issue</span>
        <input
          type="text"
          value={title}
          maxLength={140}
          placeholder="e.g. Streetlights out on the lake road for two weeks"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        <span className="k">Details (optional — posted as the first comment)</span>
        <textarea value={details} maxLength={2000} onChange={(e) => setDetails(e.target.value)} />
      </label>
      <div className="chips" role="group" aria-label="Who is this for">
        {(['ward', 'city', 'district', 'state'] as const).map((s) => (
          <button key={s} className="chip" aria-pressed={scope === s} onClick={() => setScope(s)}>
            My {s}
          </button>
        ))}
      </div>
      {error && <p className="notice warn">{error}</p>}
      <div className="chips">
        <button
          className="primary"
          disabled={busy || title.trim().length < 10}
          onClick={() => void submit()}
        >
          {busy ? 'Raising…' : 'Raise it'}
        </button>
        <button className="secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Every topic that applies to where you live, filterable, plus the documents behind them. */
export function Discuss({
  regionId,
  onOpenTopic,
}: {
  regionId: number;
  onOpenTopic: (topicId: number) => void;
}) {
  const [filter, setFilter] = useState('');
  const [topics, setTopics] = useState<Topic[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setTopics(
          (
            await client.topics({
              region_id: regionId,
              limit: 100,
              ...(filter ? { kind: filter } : {}),
            })
          ).items,
        );
      } catch {
        setTopics([]);
      }
    })();
  }, [regionId, filter]);

  return (
    <>
      <RaiseIssue onRaised={(t) => onOpenTopic(t.id)} />
      <div className="chips" role="group" aria-label="Filter topics" style={{ marginTop: 12 }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className="chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <section className="card">
        {topics === null ? (
          <p className="suppressed">Loading…</p>
        ) : topics.length === 0 ? (
          <p className="suppressed">Nothing here yet for your area.</p>
        ) : (
          topics.map((t) => (
            <button key={t.id} className="list-item" onClick={() => onOpenTopic(t.id)}>
              <div className="title">{t.title}</div>
              <div className="sub">
                <span className="badge">{KIND_LABELS[t.kind] ?? t.kind}</span>{' '}
                {t.effective_from ?? ''}
              </div>
            </button>
          ))
        )}
      </section>
      {filter === 'news' && (
        <section className="card">
          <h2>News about your area</h2>
          <p className="meta">Headlines and links only — the story is read at the publisher.</p>
          <DocumentList regionId={regionId} kinds={['news']} onOpenTopic={onOpenTopic} />
        </section>
      )}
    </>
  );
}
