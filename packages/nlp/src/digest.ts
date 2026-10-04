import { NEED_LABELS, type Digest, type Need } from '@civic-voice/contracts';
import type { ClaudeAnalyzer } from './claude.ts';

/**
 * "What does the public think, and what needs to be done?" for one topic's discussion.
 *
 * Two methods, and the digest says which it used:
 *
 *  - `claude`: the large model reads the most-upvoted comments and writes the prose (ClaudeAnalyzer).
 *  - `extractive`: no generation at all — the tone and needs come from the in-house model's labels,
 *    and "what needs to be done" is the most-upvoted comments the model flagged as suggestions,
 *    quoted, first sentence only.
 *
 * Either way the *numbers* (sentiment shares, needs shares, tone) are computed here from per-comment
 * labels over every comment considered, never taken from the model's prose, so the two methods can
 * be compared and a digest's figures can be audited against the comments.
 */
export interface DigestComment {
  id: string;
  body: string;
  upvotes: number;
  sentiment: -1 | 0 | 1 | null;
  needs: Need[];
  suggestion: boolean;
}

const share = (n: number, of: number) => (of === 0 ? 0 : Math.round((n / of) * 1000) / 1000);

export function digestFigures(comments: readonly DigestComment[]) {
  const labelled = comments.filter((c) => c.sentiment !== null);
  const counts = { negative: 0, neutral: 0, positive: 0 };
  for (const c of labelled)
    counts[c.sentiment === -1 ? 'negative' : c.sentiment === 1 ? 'positive' : 'neutral'] += 1;
  const sentiment = {
    negative: share(counts.negative, labelled.length),
    neutral: share(counts.neutral, labelled.length),
    positive: share(counts.positive, labelled.length),
  };
  const needCounts = new Map<Need, number>();
  for (const c of comments)
    for (const n of new Set(c.needs)) needCounts.set(n, (needCounts.get(n) ?? 0) + 1);
  const needs = [...needCounts]
    .map(([need, n]) => ({ need, share: share(n, comments.length) }))
    .sort((a, b) => b.share - a.share || a.need.localeCompare(b.need))
    .slice(0, 6);

  // "Mostly" needs a clear majority of the opinionated comments, not a plurality of three.
  const opinionated = counts.negative + counts.positive;
  const overall_tone: Digest['overall_tone'] =
    opinionated < Math.max(3, labelled.length * 0.3)
      ? 'neutral'
      : counts.negative >= opinionated * 0.65
        ? 'mostly_negative'
        : counts.positive >= opinionated * 0.65
          ? 'mostly_positive'
          : 'mixed';
  return { sentiment, needs, overall_tone };
}

/** First sentence, trimmed to a readable length, never cut mid-word. */
export function firstSentence(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?।॥](\s|$)/);
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).trimEnd()}…`;
}

function supportLevel(upvotes: number, top: number): 'many' | 'some' | 'few' {
  if (top <= 0) return 'few';
  const r = upvotes / top;
  return r >= 0.5 && upvotes >= 5 ? 'many' : r >= 0.2 && upvotes >= 2 ? 'some' : 'few';
}

export function extractiveDigest(
  topicId: number,
  comments: readonly DigestComment[],
  now: Date,
): Digest {
  const { sentiment, needs, overall_tone } = digestFigures(comments);
  const suggestions = comments
    .filter((c) => c.suggestion && c.body.trim().length > 0)
    .sort((a, b) => b.upvotes - a.upvotes);
  const topVotes = suggestions[0]?.upvotes ?? 0;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const concernNames = needs.slice(0, 3).map((n) => NEED_LABELS[n.need].toLowerCase());
  const concernsText =
    concernNames.length === 0
      ? ''
      : ` The most-raised concerns are ${concernNames.length === 1 ? concernNames[0] : `${concernNames.slice(0, -1).join(', ')} and ${concernNames.at(-1)}`}.`;

  return {
    topic_id: topicId,
    what_people_think:
      `Of ${comments.length} comments, ${pct(sentiment.negative)} are critical, ${pct(sentiment.positive)} supportive ` +
      `and ${pct(sentiment.neutral)} neutral.${concernsText}`,
    main_concerns: needs.slice(0, 5).map((n) => NEED_LABELS[n.need]),
    what_needs_to_be_done: suggestions.slice(0, 5).map((c) => ({
      action: `“${firstSentence(c.body)}”`,
      support: supportLevel(c.upvotes, topVotes),
    })),
    overall_tone,
    sentiment,
    needs,
    based_on_comments: comments.length,
    method: 'extractive',
    model: null,
    generated_at: now.toISOString(),
  };
}

/**
 * The large-model digest, with the audited figures from `digestFigures`. Falls back to extractive on
 * any failure — a refusal, an outage, a malformed reply — because a digest that is late or plain is
 * better than none, and the caller should not have to know which it got to show it.
 */
export async function claudeDigest(
  analyzer: ClaudeAnalyzer,
  topic: { id: number; title: string },
  comments: readonly DigestComment[],
  now: Date,
  onError?: (err: unknown) => void,
): Promise<Digest> {
  const fallback = extractiveDigest(topic.id, comments, now);
  const readable = comments.filter((c) => c.body.trim().length > 0);
  if (readable.length === 0) return fallback;
  try {
    const d = await analyzer.digest({
      topicTitle: topic.title,
      comments: readable.map((c) => ({ id: c.id, text: c.body, upvotes: c.upvotes })),
    });
    return {
      ...fallback,
      what_people_think: d.whatPeopleThink,
      main_concerns: d.mainConcerns.slice(0, 5),
      what_needs_to_be_done: d.whatNeedsToBeDone.slice(0, 5),
      method: 'claude',
      model: d.model,
    };
  } catch (err) {
    onError?.(err);
    return fallback;
  }
}
