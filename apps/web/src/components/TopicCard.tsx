import { useCallback, useEffect, useState } from 'react';
import {
  MOOD_LABELS,
  REASON_CODES,
  type DemographicDimension,
  type Mood,
  type MoodAggregate,
  type MySentiment,
  type ReasonCode,
  type Topic,
} from '@civic-voice/sdk';
import {
  CivicApiError,
  client,
  enqueue,
  flushQueue,
  hasAccount,
  idempotencyKeyFor,
} from '../api.ts';
import { AggregateFooter, DimensionBreakdown, MoodHistogram } from './MoodBars.tsx';

const MOODS: Mood[] = [-2, -1, 0, 1, 2];
const DIMENSIONS: Array<{ value: DemographicDimension | ''; label: string }> = [
  { value: '', label: 'Everyone' },
  { value: 'age_band', label: 'By age' },
  { value: 'gender', label: 'By gender' },
  { value: 'urbanity', label: 'Urban / rural' },
  { value: 'income_band', label: 'By income' },
  { value: 'education_band', label: 'By education' },
  { value: 'occupation_band', label: 'By occupation' },
  { value: 'employment_status', label: 'By employment' },
];

export function TopicCard({
  topic,
  citizenId,
  regionId,
  mine,
  onSubmitted,
}: {
  topic: Topic;
  citizenId: string | null;
  regionId: number | null;
  mine: MySentiment | undefined;
  onSubmitted: () => void;
}) {
  const [aggregate, setAggregate] = useState<MoodAggregate | null>(null);
  const [dimension, setDimension] = useState<DemographicDimension | ''>('');
  const [includeUnverified, setIncludeUnverified] = useState(false);
  const [reason, setReason] = useState<ReasonCode>('no_reason');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setAggregate(
        await client.mood(topic.id, {
          ...(regionId === null ? {} : { region_id: regionId }),
          ...(dimension === '' ? {} : { dimension }),
          // Tier 0 includes everyone; the default (T2+) is what the API returns without this.
          ...(includeUnverified ? { tier: 0 as const } : {}),
        }),
      );
    } catch (err) {
      setStatus(err instanceof CivicApiError ? err.message : 'could not load the figures');
    }
  }, [topic.id, regionId, dimension, includeUnverified]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (mood: Mood) => {
    if (!hasAccount() || citizenId === null) {
      setStatus('Choose your region below to take part.');
      return;
    }
    setBusy(true);
    setStatus(null);

    // Fixed once, here: every retry of this submission carries the same idempotency key, so a
    // timeout followed by a replay cannot record two opinions.
    const attemptToken = crypto.randomUUID();
    try {
      const result = await client.submitSentiment(
        { topic_id: topic.id, mood, intensity: 3, reason_code: reason },
        idempotencyKeyFor(citizenId, topic.id, attemptToken),
      );
      if (result.aggregate) setAggregate(result.aggregate);
      setStatus('Recorded. The public figures update within a few seconds.');
      onSubmitted();
      void flushQueue();
    } catch (err) {
      if (err instanceof CivicApiError && err.code === 'cooldown_active') {
        setStatus(
          `You changed this recently. You can change it again in about ${Math.ceil((err.retryAfterSeconds ?? 600) / 60)} minutes.`,
        );
      } else if (err instanceof CivicApiError && err.code === 'rate_limited') {
        setStatus('You have made a lot of changes recently. Please try again later.');
      } else if (err instanceof CivicApiError && !err.retryable) {
        setStatus(err.message);
      } else {
        // Network or server trouble: hold it locally and send it when the connection returns.
        enqueue({
          citizenId,
          topicId: topic.id,
          mood,
          intensity: 3,
          reasonCode: reason,
          attemptToken,
        });
        setStatus('Saved on this device. It will be sent when you are back online.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card">
      <h2>{topic.title}</h2>
      <p className="meta">
        {topic.kind.replace(/_/g, ' ')}
        {topic.effective_from ? ` · effective ${topic.effective_from}` : ''}
      </p>
      {topic.summary && <p className="meta">{topic.summary}</p>}

      <div className="mood-scale" role="group" aria-label={`How do you feel about ${topic.title}?`}>
        {MOODS.map((mood) => (
          <button
            key={mood}
            data-mood={mood}
            aria-pressed={mine?.mood === mood}
            disabled={busy}
            onClick={() => void submit(mood)}
          >
            {MOOD_LABELS[mood]}
          </button>
        ))}
      </div>

      <div className="stat-row" style={{ marginTop: 10 }}>
        <label>
          <span className="k">Reason</span>
          <br />
          <select value={reason} onChange={(e) => setReason(e.target.value as ReasonCode)}>
            {REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {code.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="k">Break down</span>
          <br />
          <select
            value={dimension}
            onChange={(e) => setDimension(e.target.value as DemographicDimension | '')}
          >
            {DIMENSIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ alignSelf: 'end' }}>
          <input
            type="checkbox"
            checked={includeUnverified}
            onChange={(e) => setIncludeUnverified(e.target.checked)}
          />{' '}
          <span style={{ fontSize: 13 }}>Include unverified</span>
        </label>
      </div>

      {status && <p className="notice">{status}</p>}

      {aggregate === null ? (
        <p className="suppressed">Loading the figures…</p>
      ) : (
        <>
          {dimension === '' ? (
            <MoodHistogram bucket={aggregate.total} />
          ) : (
            <DimensionBreakdown aggregate={aggregate} />
          )}
          <AggregateFooter aggregate={aggregate} />
        </>
      )}
    </article>
  );
}
