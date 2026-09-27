import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { MySentiment, Topic } from '@civic-voice/sdk';
import {
  client,
  flushQueue,
  pendingCount,
  restoreSession,
  saveSession,
  type Session,
} from './storage.ts';
import { TopicCard } from './screens/Decisions.tsx';
import { RtiScreen } from './screens/Rti.tsx';
import { colors, styles } from './theme.ts';

type Tab = 'decisions' | 'rti';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('decisions');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [mine, setMine] = useState<MySentiment[]>([]);
  const [pending, setPending] = useState(0);

  const refresh = useCallback(async (current: Session) => {
    try {
      setTopics((await client.topics({ region_id: current.regionId, limit: 30 })).items);
      setMine((await client.mySentiment()).items);
    } catch {
      // Offline: the cached screen stays usable and the queue keeps accepting writes.
    }
    setPending(await pendingCount());
  }, []);

  useEffect(() => {
    void (async () => {
      const restored = await restoreSession();
      setSession(restored);
      if (restored) {
        const { sent } = await flushQueue();
        await refresh(restored);
        if (sent > 0) setPending(await pendingCount());
      }
      setLoading(false);
    })();
  }, [refresh]);

  if (loading) {
    return (
      <View style={[styles.screen, { justifyContent: 'center' }]}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (session === null) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.h1}>Civic Voice</Text>
          <Text style={styles.meta}>
            Public sentiment on government decisions, the money actually spent, and the questions we
            got answered by asking.
          </Text>
          <View style={[styles.card, { marginTop: 16 }]}>
            <Text style={styles.h2}>Choose your area to begin</Text>
            <Text style={styles.meta}>
              We store no name, no phone number and no government ID. Age and similar details are
              optional, kept as broad bands, and any group of fewer than 25 people is withheld from
              every published figure.
            </Text>
            <Pressable
              style={[styles.primary, { marginTop: 14 }]}
              onPress={() => {
                void (async () => {
                  // The full picker walks the region hierarchy; this is the entry point into it.
                  const country = await client.region(1);
                  const next: Session = {
                    citizenId: '',
                    regionId: country.id,
                    regionName: country.name,
                  };
                  await saveSession(next);
                  setSession(next);
                })();
              }}
            >
              <Text style={styles.primaryText}>Choose your area</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={{ padding: 16, paddingBottom: 0 }}>
        <Text style={styles.h1}>Civic Voice</Text>
        <Text style={styles.meta}>{session.regionName}</Text>
      </View>

      {pending > 0 && (
        <View style={[styles.notice, { marginHorizontal: 16 }]}>
          <Text style={styles.noticeText}>
            {pending} response{pending === 1 ? '' : 's'} saved on your phone, waiting to be sent.
          </Text>
        </View>
      )}

      <View style={[styles.tabBar, { marginTop: 12 }]}>
        {(['decisions', 'rti'] as const).map((value) => (
          <Pressable
            key={value}
            onPress={() => setTab(value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            style={[styles.tab, tab === value ? styles.tabActive : null]}
          >
            <Text style={[styles.tabText, tab === value ? styles.tabTextActive : null]}>
              {value === 'decisions' ? 'Decisions' : 'RTI requests'}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'decisions' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {topics.length === 0 ? (
            <Text style={styles.suppressed}>No decisions published for your area yet.</Text>
          ) : (
            topics.map((topic) => (
              <TopicCard
                key={topic.id}
                topic={topic}
                citizenId={session.citizenId}
                regionId={session.regionId}
                mine={mine.find((m) => m.topic_id === topic.id)}
                onSubmitted={() => void refresh(session)}
              />
            ))
          )}
        </ScrollView>
      ) : (
        <RtiScreen />
      )}
    </View>
  );
}
