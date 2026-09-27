import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { RtiState } from '@civic-voice/sdk';
import { CivicApiError, client } from '../storage.ts';
import { colors, styles } from '../theme.ts';

type RtiView = Awaited<ReturnType<typeof client.rtiRequests>>['items'][number];

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

/**
 * The RTI screen exists mainly to carry the clock.
 *
 * Push notifications on these deadlines are the single most valuable thing the mobile app does that
 * the web cannot: a §19(1) appeal window is 30 days from a refusal that is often silent, and nobody
 * tells the citizen it started.
 */
export function RtiScreen() {
  const [items, setItems] = useState<RtiView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setItems((await client.rtiRequests()).items);
    } catch (err) {
      setError(err instanceof CivicApiError ? err.message : 'Could not load your requests.');
      setItems([]);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

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

  if (items === null) return <ActivityIndicator color={colors.accent} style={{ marginTop: 32 }} />;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {error !== null && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{error}</Text>
        </View>
      )}

      {items.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.h2}>No RTI requests yet</Text>
          <Text style={styles.meta}>
            File a request with the public authority yourself, then log it here. We will track the
            statutory clock, tell you the moment a deadline passes, and draft the appeal.
          </Text>
        </View>
      )}

      {items.map((item) => (
        <View style={styles.card} key={item.request.id}>
          <Text style={styles.h2}>{item.request.subject}</Text>
          <Text style={styles.meta}>
            filed {item.request.filed_at ?? 'not yet'} · {item.request.state.replace(/_/g, ' ')}
          </Text>

          {item.deadlines.map((deadline) => (
            <View style={styles.deadline} key={deadline.label}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.meta, deadline.breached ? styles.breached : null]}>
                  {deadline.label}
                </Text>
                <Text style={styles.statute}>{deadline.statute}</Text>
              </View>
              <View>
                <Text style={[styles.meta, deadline.breached ? styles.breached : null]}>
                  {deadline.due_on}
                </Text>
                <Text style={styles.statute}>
                  {deadline.breached
                    ? `${Math.abs(deadline.days_remaining)} days overdue`
                    : `${deadline.days_remaining} days left`}
                </Text>
              </View>
            </View>
          ))}

          <View style={styles.notice}>
            <Text style={[styles.noticeText, { color: colors.text, fontWeight: '600' }]}>
              {NEXT_LABEL[item.next_action.action] ?? item.next_action.action}
            </Text>
            <Text style={styles.noticeText}>{item.next_action.explanation}</Text>
          </View>

          {NEXT_TRANSITION[item.next_action.action] !== undefined && (
            <Pressable style={styles.primary} onPress={() => void advance(item)}>
              <Text style={styles.primaryText}>
                I have {item.next_action.action === 'close' ? 'closed this' : 'filed this appeal'}
              </Text>
            </Pressable>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
