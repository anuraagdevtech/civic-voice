import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CivicApiError,
  createClient,
  idempotencyKeyFor,
  type Mood,
  type ReasonCode,
} from '@civic-voice/sdk';

/**
 * Client and offline write queue.
 *
 * The queue is the reason this is a native app rather than a wrapped web view. On a patchy mobile
 * connection a failed submission is the normal case, so a write is persisted locally first and sent
 * when connectivity returns — carrying its **original** idempotency key, which is what makes the
 * replay safe rather than a second opinion.
 */
const TOKEN_KEY = 'civic.token';
const QUEUE_KEY = 'civic.queue';
const SESSION_KEY = 'civic.session';

export interface Session {
  citizenId: string;
  regionId: number;
  regionName: string;
  /** Root first, inclusive. Absent in sessions saved before it existed; re-fetched when missing. */
  regionPath?: number[];
}

export interface QueuedWrite {
  citizenId: string;
  topicId: number;
  mood: Mood;
  intensity: number;
  reasonCode: ReasonCode;
  /** Fixed at the first attempt, so every retry carries the same idempotency key. */
  attemptToken: string;
  queuedAt: string;
}

const apiUrl = process.env['EXPO_PUBLIC_API_URL'] ?? 'https://api.civicvoice.example';

export const client = createClient({
  baseUrl: apiUrl,
  // A mobile network can stall for a long time without failing; a shorter deadline lets the queue
  // take over instead of leaving the citizen staring at a spinner.
  timeoutMs: 8_000,
  onTokenChange: (token) => {
    void (token === null
      ? AsyncStorage.removeItem(TOKEN_KEY)
      : AsyncStorage.setItem(TOKEN_KEY, token));
  },
});

export async function restoreSession(): Promise<Session | null> {
  const [token, raw] = await Promise.all([
    AsyncStorage.getItem(TOKEN_KEY),
    AsyncStorage.getItem(SESSION_KEY),
  ]);
  if (token) client.setAccessToken(token);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function saveSession(session: Session): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function readQueue(): Promise<QueuedWrite[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? '[]') as QueuedWrite[];
  } catch {
    return [];
  }
}

export async function enqueue(write: Omit<QueuedWrite, 'queuedAt'>): Promise<void> {
  // One pending write per topic: a citizen has one standing opinion, so a newer choice supersedes an
  // older queued one rather than both being sent in sequence.
  const queue = (await readQueue()).filter((q) => q.topicId !== write.topicId);
  queue.push({ ...write, queuedAt: new Date().toISOString() });
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function pendingCount(): Promise<number> {
  return (await readQueue()).length;
}

export async function flushQueue(): Promise<{ sent: number; dropped: number }> {
  let sent = 0;
  let dropped = 0;
  const remaining: QueuedWrite[] = [];

  for (const write of await readQueue()) {
    try {
      await client.submitSentiment(
        {
          topic_id: write.topicId,
          mood: write.mood,
          intensity: write.intensity,
          reason_code: write.reasonCode,
        },
        idempotencyKeyFor(write.citizenId, write.topicId, write.attemptToken),
      );
      sent += 1;
    } catch (err) {
      if (err instanceof CivicApiError && !err.retryable) {
        // Will never succeed — a validation failure, a cooldown, a topic that does not apply.
        // Retrying it forever would be a silent loop that drains the battery.
        dropped += 1;
      } else {
        remaining.push(write);
      }
    }
  }
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  return { sent, dropped };
}

export { CivicApiError, idempotencyKeyFor };
