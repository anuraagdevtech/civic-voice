import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  NEED_LABELS,
  newWriteKey,
  type CommentView,
  type Digest,
  type JobsSummary,
  type TrendingItem,
} from '@civic-voice/sdk';
import { CivicApiError, client } from '../storage.ts';
import { colors, styles } from '../theme.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The forum on the phone: what people where you live are discussing, what they think, and a place to
 * say what should be done. Same API, same rules as the web — residents only, no phone numbers.
 */
function Thread({
  topicId,
  regionPath,
  onBack,
}: {
  topicId: number;
  regionPath: number[];
  onBack: () => void;
}) {
  const [title, setTitle] = useState('');
  const [jurisdiction, setJurisdiction] = useState<{ id: number; name: string } | null>(null);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [comments, setComments] = useState<CommentView[] | null>(null);
  const [draft, setDraft] = useState('');
  const [key, setKey] = useState(newWriteKey);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const topic = await client.topic(topicId);
      setTitle(topic.title);
      setJurisdiction({
        id: topic.jurisdiction_region_id,
        name: (await client.region(topic.jurisdiction_region_id)).name,
      });
      setDigest((await client.digest(topicId)).digest);
      setComments((await client.comments(topicId, { sort: 'top', limit: 30 })).items);
    } catch {
      setStatus('Could not load this discussion.');
    }
  }, [topicId]);

  useEffect(() => {
    void load();
  }, [load]);

  const local = jurisdiction !== null && regionPath.includes(jurisdiction.id);

  const post = async () => {
    setStatus(null);
    try {
      await client.postComment(topicId, { body: draft }, key);
      setDraft('');
      setKey(newWriteKey());
      setStatus('Posted. It appears once it has been checked, usually within seconds.');
      setTimeout(() => void load(), 2500);
    } catch (err) {
      setStatus(
        err instanceof CivicApiError
          ? err.message
          : 'Could not post. It will not be retried automatically.',
      );
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} accessibilityRole="button">
        <Text style={{ color: colors.accent, marginBottom: 8 }}>← Back</Text>
      </Pressable>
      <Text style={styles.h1}>{title}</Text>
      {jurisdiction && <Text style={styles.meta}>For residents of {jurisdiction.name}</Text>}

      <View style={[styles.card, { marginTop: 12 }]}>
        <Text style={styles.h2}>What people think</Text>
        {digest ? (
          <>
            <Text style={styles.meta}>
              {digest.based_on_comments} comments ·{' '}
              {digest.method === 'claude'
                ? 'summarised by a language model'
                : 'from the comments, no generated text'}
            </Text>
            <Text style={{ color: colors.text, marginTop: 8, lineHeight: 21 }}>
              {digest.what_people_think}
            </Text>
            <Text style={[styles.meta, { marginTop: 6 }]}>
              {pct(digest.sentiment.negative)} critical · {pct(digest.sentiment.positive)}{' '}
              supportive
            </Text>
            {digest.what_needs_to_be_done.length > 0 && (
              <Text style={[styles.h2, { marginTop: 12 }]}>What needs to be done</Text>
            )}
            {digest.what_needs_to_be_done.map((a, i) => (
              <Text key={i} style={{ color: colors.text, marginTop: 4 }}>
                {i + 1}. {a.action}
              </Text>
            ))}
          </>
        ) : (
          <Text style={styles.suppressed}>
            A summary appears once enough people have commented.
          </Text>
        )}
      </View>

      {local ? (
        <View style={styles.card}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={2000}
            placeholder="What do you think? What should be done?"
            placeholderTextColor={colors.textDim}
            style={{ color: colors.text, minHeight: 80, textAlignVertical: 'top' }}
          />
          <Text style={[styles.meta, { marginVertical: 6 }]}>
            Public, under a name used only on this topic. No phone or ID numbers.
          </Text>
          <Pressable
            style={styles.primary}
            disabled={draft.trim().length < 3}
            onPress={() => void post()}
          >
            <Text style={styles.primaryText}>Post</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Only residents of {jurisdiction?.name ?? 'this area'} can post here. You can read it.
          </Text>
        </View>
      )}
      {status && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{status}</Text>
        </View>
      )}

      {comments === null ? (
        <ActivityIndicator color={colors.accent} />
      ) : comments.length === 0 ? (
        <Text style={styles.suppressed}>No comments yet.</Text>
      ) : (
        comments.map((c) => (
          <View key={c.id} style={[styles.card, { paddingVertical: 10 }]}>
            <Text style={styles.meta}>
              {c.handle}
              {c.area ? ` · ${c.area}` : ''}
              {c.located ? ' · 📍 located' : ''} · ▲ {c.upvotes}
            </Text>
            <Text style={{ color: colors.text, marginTop: 4, lineHeight: 21 }}>{c.body}</Text>
            {c.analysis && c.analysis.needs.length > 0 && (
              <Text style={[styles.meta, { marginTop: 4 }]}>
                {c.analysis.needs.map((n) => NEED_LABELS[n]).join(' · ')}
              </Text>
            )}
          </View>
        ))
      )}
    </ScrollView>
  );
}

export function DiscussScreen({
  regionId,
  regionPath,
}: {
  regionId: number;
  regionPath: number[];
}) {
  const [trending, setTrending] = useState<TrendingItem[] | null>(null);
  const [jobs, setJobs] = useState<JobsSummary | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const lists = await Promise.all(
          regionPath.map((id) => client.trending(id, 20).then((r) => r.items)),
        );
        const merged = new Map<number, TrendingItem>();
        for (const t of lists.flat())
          if (regionPath.includes(t.jurisdiction_region_id)) merged.set(t.topic_id, t);
        setTrending([...merged.values()].sort((a, b) => b.score - a.score).slice(0, 12));
      } catch {
        setTrending([]);
      }
      try {
        setJobs(await client.jobs(regionId));
      } catch {
        setJobs(null);
      }
    })();
  }, [regionId, regionPath.join(',')]);

  if (open !== null)
    return <Thread topicId={open} regionPath={regionPath} onBack={() => setOpen(null)} />;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {jobs && (
        <View style={styles.card}>
          <Text style={styles.h2}>Government jobs open to you</Text>
          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statN}>{jobs.open_notifications.toLocaleString('en-IN')}</Text>
              <Text style={styles.statK}>notifications</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statN}>{jobs.stated_vacancies.toLocaleString('en-IN')}+</Text>
              <Text style={styles.statK}>posts stated</Text>
            </View>
          </View>
        </View>
      )}
      <Text style={[styles.h2, { marginBottom: 8 }]}>Hot topics where you live</Text>
      {trending === null ? (
        <ActivityIndicator color={colors.accent} />
      ) : trending.length === 0 ? (
        <Text style={styles.suppressed}>Nothing is being discussed yet.</Text>
      ) : (
        trending.map((t) => (
          <Pressable
            key={t.topic_id}
            style={styles.card}
            onPress={() => setOpen(t.topic_id)}
            accessibilityRole="button"
          >
            <Text style={{ color: colors.text, fontSize: 15, lineHeight: 21 }}>{t.title}</Text>
            <Text style={[styles.meta, { marginTop: 4 }]}>
              {t.jurisdiction_name} · {t.comments_24h} comments today
            </Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}
