import { useEffect, useState } from 'react';
import { RTI_TRACKS, type Authority, type RtiState, type RtiTrack } from '@civic-voice/sdk';
import { CivicApiError, client } from '../api.ts';

type RtiView = Awaited<ReturnType<typeof client.rtiRequests>>['items'][number];

/**
 * RTI tracking.
 *
 * The product value is the clock: it shows the statutory deadline, the section it comes from, and the
 * one thing the citizen can do next. A request that has lapsed into deemed refusal says so, because
 * the appeal window is only 30 days from that point and nobody is told when it starts.
 */
const NEXT_LABEL: Record<string, string> = {
  await_response: 'Waiting for the authority',
  file_first_appeal: 'File a first appeal — free',
  await_fa_response: 'Waiting for the appellate authority',
  file_second_appeal: 'Appeal to the Information Commission',
  await_sic_response: 'Waiting for the Commission',
  close: 'You can close this',
  none: 'Nothing to do',
};

const NEXT_TRANSITION: Partial<Record<string, RtiState>> = {
  file_first_appeal: 'first_appeal',
  file_second_appeal: 'second_appeal',
  close: 'closed',
};

export function RtiPanel({ authorities }: { authorities: Authority[] }) {
  const [items, setItems] = useState<RtiView[]>([]);
  const [authorityId, setAuthorityId] = useState<number | ''>('');
  const [subject, setSubject] = useState('');
  const [track, setTrack] = useState<RtiTrack>('standard');
  const [filedAt, setFiledAt] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setItems((await client.rtiRequests()).items);
    } catch {
      /* not signed in yet */
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const create = async () => {
    if (authorityId === '' || subject.trim().length < 10) {
      setError('Choose an authority and describe what you asked for (at least 10 characters).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.createRtiRequest({
        authority_id: authorityId,
        subject: subject.trim(),
        track,
        filed_at: filedAt,
      });
      setSubject('');
      await reload();
    } catch (err) {
      setError(err instanceof CivicApiError ? err.message : 'Could not save this request.');
    } finally {
      setBusy(false);
    }
  };

  const advance = async (item: RtiView) => {
    const to = NEXT_TRANSITION[item.next_action.action];
    if (!to) return;
    try {
      await client.transitionRti(item.request.id, to);
      await reload();
    } catch (err) {
      setError(err instanceof CivicApiError ? err.message : 'Could not update this request.');
    }
  };

  const authorityName = (id: number) =>
    authorities.find((a) => a.id === id)?.name ?? `Authority ${id}`;
  const faaFor = (id: number) => authorities.find((a) => a.id === id)?.faa_contact;

  return (
    <>
      <section className="card">
        <h2>Track an RTI request</h2>
        <p className="meta">
          You file the request yourself — we cannot be the applicant without breaking your standing
          under the Act. Log it here and we will track the statutory clock, tell you the moment a
          deadline passes, and draft the appeal.
        </p>

        <div style={{ display: 'grid', gap: 10 }}>
          <label>
            <span className="k">Public authority</span>
            <br />
            <select
              value={authorityId}
              onChange={(e) => setAuthorityId(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">Choose…</option>
              {authorities.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="k">What did you ask for?</span>
            <br />
            <input
              style={{ width: '100%' }}
              value={subject}
              maxLength={500}
              placeholder="e.g. Number of tap connections completed in this district in FY 2025-26"
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <div className="stat-row">
            <label>
              <span className="k">Type</span>
              <br />
              <select value={track} onChange={(e) => setTrack(e.target.value as RtiTrack)}>
                {RTI_TRACKS.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="k">Date filed</span>
              <br />
              <input type="date" value={filedAt} onChange={(e) => setFiledAt(e.target.value)} />
            </label>
          </div>
        </div>

        {error && <p className="notice warn">{error}</p>}
        <button
          className="primary"
          disabled={busy}
          onClick={() => void create()}
          style={{ marginTop: 12 }}
        >
          {busy ? 'Saving…' : 'Track this request'}
        </button>
      </section>

      {items.map((item) => (
        <article className="card" key={item.request.id}>
          <h2>{item.request.subject}</h2>
          <p className="meta">
            {authorityName(item.request.authority_id)} · filed {item.request.filed_at ?? 'not yet'}{' '}
            · <strong>{item.request.state.replace(/_/g, ' ')}</strong>
          </p>

          {item.deadlines.map((deadline) => (
            <div className={`deadline${deadline.breached ? ' breached' : ''}`} key={deadline.label}>
              <span>
                {deadline.label}
                <br />
                <span className="statute">{deadline.statute}</span>
              </span>
              <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {deadline.due_on}
                <br />
                <span className="statute">
                  {deadline.breached
                    ? `${Math.abs(deadline.days_remaining)} days overdue`
                    : `${deadline.days_remaining} days left`}
                </span>
              </span>
            </div>
          ))}

          <p className="notice">
            <strong>{NEXT_LABEL[item.next_action.action] ?? item.next_action.action}</strong>
            <br />
            {item.next_action.explanation}
            {item.next_action.action === 'file_first_appeal' &&
              faaFor(item.request.authority_id) && (
                <>
                  <br />
                  Appeal to: <code>{faaFor(item.request.authority_id)}</code>
                </>
              )}
          </p>

          {NEXT_TRANSITION[item.next_action.action] && (
            <button className="primary" onClick={() => void advance(item)}>
              I have {item.next_action.action === 'close' ? 'closed this' : 'filed this appeal'}
            </button>
          )}
        </article>
      ))}
    </>
  );
}
