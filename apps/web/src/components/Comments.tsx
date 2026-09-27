import { useCallback, useEffect, useState } from 'react';
import { NEED_LABELS, newWriteKey, type CommentView, type ReportReason } from '@civic-voice/sdk';
import { CivicApiError, client, hasAccount } from '../api.ts';
import { ago } from '../format.ts';

const REPORT_REASONS: Array<[ReportReason, string]> = [
  ['abuse', 'Abusive'],
  ['hate', 'Hateful'],
  ['threat', 'Threatening'],
  ['personal_info', 'Shares personal information'],
  ['spam', 'Spam'],
  ['misinformation', 'False information'],
  ['off_topic', 'Off topic'],
];

function Comment({
  comment,
  upvoted,
  canAct,
  onVote,
  onReply,
  onReport,
}: {
  comment: CommentView;
  upvoted: boolean;
  canAct: boolean;
  onVote: (on: boolean) => void;
  onReply?: () => void;
  onReport: (reason: ReportReason) => void;
}) {
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const a = comment.analysis;
  return (
    <div className={`comment${comment.parent_id ? ' reply' : ''}`}>
      <div className="who">
        <strong>{comment.handle}</strong>
        {comment.area && <span>{comment.area}</span>}
        {comment.located && (
          <span
            className="badge local"
            title="Their home area was confirmed from their device's location"
          >
            📍 located
          </span>
        )}
        <span>{ago(comment.created_at)}</span>
      </div>
      <p className="body">{comment.body}</p>
      {a && (a.needs.length > 0 || a.suggestion) && (
        <div className="chips" style={{ margin: '0 0 4px' }}>
          {a.suggestion && <span className="chip">💡 suggestion</span>}
          {a.needs.map((n) => (
            <span key={n} className="chip">
              {NEED_LABELS[n]}
            </span>
          ))}
        </div>
      )}
      <div className="actions">
        <button aria-pressed={upvoted} disabled={!canAct} onClick={() => onVote(!upvoted)}>
          ▲ {comment.upvotes}
        </button>
        {onReply && canAct && <button onClick={onReply}>Reply</button>}
        {canAct && !reported && (
          <button onClick={() => setReporting(!reporting)} aria-expanded={reporting}>
            Report
          </button>
        )}
        {reported && <span className="meta">Reported — thank you</span>}
      </div>
      {reporting && (
        <div className="chips">
          {REPORT_REASONS.map(([reason, label]) => (
            <button
              key={reason}
              className="chip"
              onClick={() => {
                onReport(reason);
                setReporting(false);
                setReported(true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({
  topicId,
  parentId,
  placeholder,
  onPosted,
}: {
  topicId: number;
  parentId: string | null;
  placeholder: string;
  onPosted: (handle: string, body: string) => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per draft: a retry after a timeout replays instead of posting twice.
  const [key, setKey] = useState(newWriteKey);

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await client.postComment(topicId, { body, parent_id: parentId }, key);
      onPosted(res.handle, body);
      setBody('');
      setKey(newWriteKey());
    } catch (err) {
      setError(err instanceof CivicApiError ? err.message : 'Could not post. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ margin: '8px 0' }}>
      <textarea
        value={body}
        maxLength={2000}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        aria-label={placeholder}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          marginTop: 6,
        }}
      >
        <span className="meta" style={{ margin: 0 }}>
          Public, under a name used only on this topic. No phone numbers or ID numbers.
        </span>
        <button
          className="primary"
          disabled={busy || body.trim().length < 3}
          onClick={() => void post()}
        >
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
      {error && <p className="notice warn">{error}</p>}
    </div>
  );
}

/**
 * The thread. Anyone can read it; only residents of the topic's area can post, reply or vote — the
 * API enforces that, and the page says so up front rather than after someone has typed a paragraph.
 */
export function Comments({
  topicId,
  isLocal,
  jurisdictionName,
  onActivity,
}: {
  topicId: number;
  isLocal: boolean;
  jurisdictionName: string | null;
  onActivity: () => void;
}) {
  const [sort, setSort] = useState<'top' | 'new'>('top');
  const [items, setItems] = useState<CommentView[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, CommentView[]>>({});
  const [upvoted, setUpvoted] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [pending, setPending] = useState<Array<{ handle: string; body: string }>>([]);
  const canAct = isLocal && hasAccount();

  const load = useCallback(
    async (more: boolean) => {
      try {
        const page = await client.comments(topicId, {
          sort,
          limit: 20,
          ...(more && cursor ? { cursor } : {}),
        });
        const next = more
          ? [...items, ...page.items.filter((c) => !items.some((i) => i.id === c.id))]
          : page.items;
        setItems(next);
        setTotal(page.total);
        setCursor(page.next_cursor);
        if (hasAccount() && page.items.length > 0) {
          const mine = await client.myVotes(
            topicId,
            page.items.map((c) => c.id),
          );
          setUpvoted((prev) => new Set([...(more ? prev : []), ...mine.upvoted]));
        }
      } catch {
        /* the empty state covers it */
      }
    },
    [topicId, sort, cursor, items],
  );

  useEffect(() => {
    void load(false);
    // Reload on topic or order change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, sort]);

  const vote = async (comment: CommentView, on: boolean) => {
    try {
      const res = await client.vote(topicId, comment.id, on);
      setUpvoted((prev) => {
        const next = new Set(prev);
        if (res.upvoted) next.add(comment.id);
        else next.delete(comment.id);
        return next;
      });
      const patch = (c: CommentView) => (c.id === comment.id ? { ...c, upvotes: res.upvotes } : c);
      setItems((prev) => prev.map(patch));
      setReplies((prev) =>
        Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, v.map(patch)])),
      );
    } catch {
      /* a failed vote leaves the count as it was */
    }
  };

  const showReplies = async (parent: CommentView) => {
    const page = await client.comments(topicId, { parent_id: parent.id, limit: 50 });
    setReplies((prev) => ({ ...prev, [parent.id]: page.items }));
  };

  const report = (comment: CommentView, reason: ReportReason) =>
    void client.reportComment(topicId, comment.id, reason).catch(() => {});

  return (
    <section className="card">
      <h2>Discussion · {total}</h2>
      {canAct ? (
        <Composer
          topicId={topicId}
          parentId={null}
          placeholder="What do you think? What should be done?"
          onPosted={(handle, body) => {
            setPending((p) => [{ handle, body }, ...p]);
            onActivity();
            // The worker publishes within seconds; pick it up without making anyone refresh.
            setTimeout(() => {
              setPending([]);
              void load(false);
            }, 2500);
          }}
        />
      ) : (
        <p className="notice">
          {hasAccount()
            ? `This discussion is for residents of ${jurisdictionName ?? 'the area it concerns'}. You can read it; only people who live there can post or vote.`
            : 'Choose where you live to take part.'}
        </p>
      )}

      <div className="chips" role="group" aria-label="Order">
        <button className="chip" aria-pressed={sort === 'top'} onClick={() => setSort('top')}>
          Most backed
        </button>
        <button className="chip" aria-pressed={sort === 'new'} onClick={() => setSort('new')}>
          Newest
        </button>
      </div>

      {pending.map((p, i) => (
        <div key={`p${i}`} className="comment" style={{ opacity: 0.7 }}>
          <div className="who">
            <strong>{p.handle}</strong>
            <span>posting…</span>
          </div>
          <p className="body">{p.body}</p>
        </div>
      ))}

      {items.length === 0 && pending.length === 0 && <p className="suppressed">No comments yet.</p>}

      {items.map((c) => (
        <div key={c.id}>
          <Comment
            comment={c}
            upvoted={upvoted.has(c.id)}
            canAct={canAct}
            onVote={(on) => void vote(c, on)}
            onReply={() => setReplyTo(replyTo === c.id ? null : c.id)}
            onReport={(reason) => report(c, reason)}
          />
          {c.reply_count > 0 && !replies[c.id] && (
            <button className="link" style={{ marginLeft: 18 }} onClick={() => void showReplies(c)}>
              {c.reply_count} {c.reply_count === 1 ? 'reply' : 'replies'}
            </button>
          )}
          {(replies[c.id] ?? []).map((r) => (
            <Comment
              key={r.id}
              comment={r}
              upvoted={upvoted.has(r.id)}
              canAct={canAct}
              onVote={(on) => void vote(r, on)}
              onReport={(reason) => report(r, reason)}
            />
          ))}
          {replyTo === c.id && (
            <div className="comment reply">
              <Composer
                topicId={topicId}
                parentId={c.id}
                placeholder={`Reply to ${c.handle}`}
                onPosted={() => {
                  setReplyTo(null);
                  setTimeout(() => void showReplies(c), 2500);
                }}
              />
            </div>
          )}
        </div>
      ))}

      {cursor && (
        <button className="secondary" onClick={() => void load(true)}>
          More comments
        </button>
      )}
    </section>
  );
}
