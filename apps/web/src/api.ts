import {
  CivicApiError,
  createClient,
  idempotencyKeyFor,
  type CivicVoiceClient,
} from '@civic-voice/sdk';

/**
 * The client, plus the offline write queue.
 *
 * A civic app is used on patchy mobile networks, so a failed submission is the normal case rather
 * than the edge case. Queued writes keep their original idempotency key, which is what makes a replay
 * safe — the server recognises it and returns the stored response instead of recording a second
 * opinion.
 */
const STORAGE_KEY = 'civic.token';
const QUEUE_KEY = 'civic.queue';

const readStored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private browsing, blocked site data: the app must still work, just without persistence.
    return null;
  }
};

const writeStored = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

export const client: CivicVoiceClient = createClient({
  baseUrl: import.meta.env['VITE_API_URL'] ?? '',
  accessToken: readStored(STORAGE_KEY) ?? undefined,
  onTokenChange: (token) => writeStored(STORAGE_KEY, token),
});

export const hasAccount = (): boolean => readStored(STORAGE_KEY) !== null;

export interface QueuedWrite {
  citizenId: string;
  topicId: number;
  mood: -2 | -1 | 0 | 1 | 2;
  intensity: number;
  reasonCode: string;
  /** Fixed at first attempt, so every retry carries the same idempotency key. */
  attemptToken: string;
}

const readQueue = (): QueuedWrite[] => {
  try {
    return JSON.parse(readStored(QUEUE_KEY) ?? '[]') as QueuedWrite[];
  } catch {
    return [];
  }
};

const writeQueue = (queue: QueuedWrite[]): void => {
  writeStored(QUEUE_KEY, JSON.stringify(queue));
};

export function enqueue(write: QueuedWrite): void {
  const queue = readQueue().filter(
    // One pending write per topic: a citizen has one standing opinion, so a newer choice supersedes
    // an older queued one rather than both being sent.
    (q) => q.topicId !== write.topicId,
  );
  queue.push(write);
  writeQueue(queue);
}

export function queueLength(): number {
  return readQueue().length;
}

/** Drain the queue. Called on reconnect and after a successful interactive write. */
export async function flushQueue(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const remaining: QueuedWrite[] = [];

  for (const write of readQueue()) {
    try {
      await client.submitSentiment(
        {
          topic_id: write.topicId,
          mood: write.mood,
          intensity: write.intensity,
          reason_code: write.reasonCode as never,
        },
        idempotencyKeyFor(write.citizenId, write.topicId, write.attemptToken),
      );
      sent += 1;
    } catch (err) {
      if (err instanceof CivicApiError && !err.retryable) {
        // A rejection that will never succeed — a validation error, a cooldown, a topic that does not
        // apply. Dropping it is right; retrying forever would be a silent loop.
        failed += 1;
      } else {
        remaining.push(write);
      }
    }
  }
  writeQueue(remaining);
  return { sent, failed };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flushQueue());
}

export { CivicApiError, idempotencyKeyFor };
