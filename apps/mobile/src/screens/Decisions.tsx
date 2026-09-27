import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import {
  MOOD_LABELS,
  type Mood,
  type MoodAggregate,
  type MoodBucket,
  type MySentiment,
  type Topic,
} from '@civic-voice/sdk';
import { CivicApiError, client, enqueue, flushQueue, idempotencyKeyFor } from '../storage.ts';
import { colors, styles } from '../theme.ts';

const MOODS: Mood[] = [-2, -1, 0, 1, 2];

function Distribution({ bucket }: { bucket: MoodBucket }) {
  if (bucket.suppressed || bucket.histogram === null) {
    return (
      <Text style={styles.suppressed}>
        {bucket.suppression_reason === 'quarantined'
          ? 'withheld — flagged as anomalous'
          : 'withheld — fewer than 25 people'}
      </Text>
    );
  }
  const total = bucket.histogram.reduce((a, b) => a + b, 0);
  return (
    <View style={{ marginVertical: 10 }}>
      {MOODS.map((mood) => {
        const count = bucket.histogram?.[mood + 2] ?? 0;
        const share = total > 0 ? (count / total) * 100 : 0;
        return (
          <View style={styles.barRow} key={mood}>
            <Text style={styles.barLabel}>{MOOD_LABELS[mood]}</Text>
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.barFill,
                  { width: `${share}%`, backgroundColor: colors.mood[String(mood)] },
                ]}
              />
            </View>
            <Text style={styles.barValue}>{share.toFixed(0)}%</Text>
          </View>
        );
      })}
    </View>
  );
}

export function TopicCard({
  topic,
  citizenId,
  regionId,
  mine,
  onSubmitted,
}: {
  topic: Topic;
  citizenId: string;
  regionId: number;
  mine: MySentiment | undefined;
  onSubmitted: () => void;
}) {
  const [aggregate, setAggregate] = useState<MoodAggregate | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setAggregate(await client.mood(topic.id, { region_id: regionId }));
    } catch {
      setStatus('Could not load the figures. Pull to refresh when you are back online.');
    }
  }, [topic.id, regionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (mood: Mood) => {
    setBusy(true);
    setStatus(null);
    // Fixed once: every retry of this submission carries the same idempotency key.
    const attemptToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const result = await client.submitSentiment(
        { topic_id: topic.id, mood, intensity: 3, reason_code: 'no_reason' },
        idempotencyKeyFor(citizenId, topic.id, attemptToken),
      );
      if (result.aggregate) setAggregate(result.aggregate);
      setStatus('Recorded.');
      onSubmitted();
      void flushQueue();
    } catch (err) {
      if (err instanceof CivicApiError && err.code === 'cooldown_active') {
        setStatus(
          `You changed this recently. You can change it again in about ${Math.ceil((err.retryAfterSeconds ?? 600) / 60)} minutes.`,
        );
      } else if (err instanceof CivicApiError && !err.retryable) {
        setStatus(err.message);
      } else {
        // Held locally and sent on reconnect. On these networks this is the expected path, so the
        // copy says "saved", not "failed".
        await enqueue({
          citizenId,
          topicId: topic.id,
          mood,
          intensity: 3,
          reasonCode: 'no_reason',
          attemptToken,
        });
        setStatus('Saved on your phone. It will be sent when you are back online.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.h2}>{topic.title}</Text>
      <Text style={styles.meta}>
        {topic.kind.replace(/_/g, ' ')}
        {topic.effective_from ? ` · effective ${topic.effective_from}` : ''}
      </Text>

      <View style={styles.moodRow}>
        {MOODS.map((mood) => {
          const selected = mine?.mood === mood;
          return (
            <Pressable
              key={mood}
              disabled={busy}
              onPress={() => void submit(mood)}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: busy }}
              accessibilityLabel={`${MOOD_LABELS[mood]} about ${topic.title}`}
              style={[
                styles.moodButton,
                selected ? { borderColor: colors.mood[String(mood)] } : null,
              ]}
            >
              <Text
                style={[
                  styles.moodButtonText,
                  { color: colors.mood[String(mood)], fontWeight: selected ? '700' : '500' },
                ]}
              >
                {MOOD_LABELS[mood]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {status !== null && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{status}</Text>
        </View>
      )}

      {aggregate === null ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />
      ) : (
        <>
          <Distribution bucket={aggregate.total} />
          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statN}>
                {aggregate.total.suppressed ? '—' : aggregate.total.n.toLocaleString('en-IN')}
              </Text>
              <Text style={styles.statK}>people</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statN}>{aggregate.total.mean_mood?.toFixed(2) ?? '—'}</Text>
              <Text style={styles.statK}>mean mood</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statN}>T{aggregate.tier}+</Text>
              <Text style={styles.statK}>verification</Text>
            </View>
          </View>
          <Text style={styles.suppressed}>
            Updated {aggregate.staleness_seconds}s ago. Groups of fewer than 25 people are withheld.
          </Text>
        </>
      )}
    </View>
  );
}
