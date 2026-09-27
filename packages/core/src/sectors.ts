import {
  FISCAL_LABELS,
  NEED_LABELS,
  NEED_SECTOR,
  NEEDS,
  PROGRAMME_SECTORS,
  type FiscalStage,
  type Need,
  type ProgrammeSector,
  type ProvenanceKind,
  type SectorInsightRow,
} from '@civic-voice/contracts';
import { applyAnonymityGate, emptyRawBucket, type RawBucket } from './anonymity.ts';
import { availableYears, bestStage, previousFy, type FiscalFigure } from './finance.ts';

/**
 * Opinion against allocation, sector by sector: what a government spends on each programme, what its
 * residents raise, and how they feel about its decisions there.
 *
 * Three privacy rules shape this, all inherited from the one gate (`applyAnonymityGate`):
 *
 *  - **Attention** is gated on distinct voices per sector, with complementary suppression across the
 *    sectors, because the sector shares are published together and would otherwise subtract.
 *  - **Mood** is combined across a sector's topics only after each topic has been gated on its own.
 *    Pseudonyms are per topic (ADR-0005), so the same person across two topics cannot be counted once
 *    — there is no way to gate "people in the sector". Gating each topic first means every number that
 *    goes into a sum was publishable by itself, so the sum reveals nothing a topic page would not.
 *  - The combined sector figures pass through the gate again, as every published slice does.
 */

/** Comment figures for one group of needs, as the analytics store reports them. */
export interface GroupFigures {
  voices: number;
  comments: number;
  negative: number;
  neutral: number;
  positive: number;
}

export interface SectorTopicSlice {
  topicId: number;
  sector: ProgrammeSector;
  /** The topic's total (dimension 0) at the region; absent when nobody there has an opinion yet. */
  total: RawBucket | undefined;
  /** The topic's buckets for the requested dimension; empty for the undifferentiated view. */
  buckets: readonly RawBucket[];
  quarantined: ReadonlySet<string>;
}

export interface SectorInputs {
  figures: readonly FiscalFigure[];
  fy?: string;
  stage?: FiscalStage;
  /** Null when there is no analytical store: attention is then reported as suppressed. */
  comments: { voices: number; groups: Readonly<Record<string, GroupFigures>> } | null;
  slices: readonly SectorTopicSlice[];
  /** The dimension's buckets, or null for totals only. */
  expectedBuckets: readonly string[] | null;
  k: number;
}

/** Needs no budget head answers: raised, reported, and never forced into a sector. */
export const UNMAPPED_NEEDS: readonly Need[] = NEEDS.filter((n) => NEED_SECTOR[n] === null);

/** Need groups to ask the analytics store for: each sector's needs, and each unmapped need alone. */
export function sectorNeedGroups(): Record<string, Need[]> {
  const groups: Record<string, Need[]> = {};
  for (const need of NEEDS) {
    const key = NEED_SECTOR[need] ?? need;
    (groups[key] ??= []).push(need);
  }
  return groups;
}

function add(into: RawBucket, b: RawBucket): void {
  into.n += b.n;
  into.sumMood += b.sumMood;
  into.sumIntensity += b.sumIntensity;
  for (let i = 0; i < 5; i += 1)
    into.histogram[i] = (into.histogram[i] as number) + (b.histogram[i] as number);
}

function sectorMood(
  slices: readonly SectorTopicSlice[],
  expected: readonly string[] | null,
  k: number,
): SectorInsightRow['mood'] {
  const total = emptyRawBucket('all');
  const sums = new Map((expected ?? []).map((b) => [b, emptyRawBucket(b)]));
  // Groups that had people in some topic, all of them withheld there. Their sector sum reads zero,
  // and zero would say "nobody" — so they are withheld here too.
  const withheld = new Set<string>();
  let counted = 0;
  for (const slice of slices) {
    if (!slice.total) continue;
    const seen = new Map(slice.buckets.map((b) => [b.bucket, b]));
    const buckets = (expected ?? []).map((name) => seen.get(name) ?? emptyRawBucket(name));
    const gated = applyAnonymityGate(slice.total, buckets, { k, quarantined: slice.quarantined });
    if (gated.total.suppressed) continue;
    counted += 1;
    add(total, slice.total);
    gated.buckets.forEach((g, i) => {
      const b = buckets[i] as RawBucket;
      if (!g.suppressed) add(sums.get(g.bucket) as RawBucket, b);
      else if (b.n > 0) withheld.add(g.bucket);
    });
  }
  const gated = applyAnonymityGate(total, [...sums.values()], { k });
  const buckets = gated.buckets.map((b) =>
    !b.suppressed && b.n === 0 && withheld.has(b.bucket)
      ? {
          ...b,
          histogram: null,
          mean_mood: null,
          mean_intensity: null,
          suppressed: true,
          suppression_reason: 'below_k' as const,
        }
      : b,
  );
  return {
    topics: slices.length,
    topics_counted: counted,
    total: gated.total,
    buckets: expected ? buckets : [],
  };
}

export function summariseSectors(input: SectorInputs): {
  fy: string | null;
  stage: FiscalStage | null;
  rows: SectorInsightRow[];
  unmapped: Array<{ need: Need; label: string; comments: number | null }>;
  provenance: ProvenanceKind[];
  sources: Array<{ name: string; url: string }>;
} {
  // Spending: the requested year and stage, else the latest year at its most final stage.
  const fy = input.fy ?? availableYears(input.figures)[0]?.fy ?? null;
  const stage = fy ? (input.stage ?? bestStage(input.figures, fy)) : null;
  const current = input.figures.filter((f) => f.fy === fy && f.stage === stage);
  const prevStage = fy ? bestStage(input.figures, previousFy(fy)) : null;
  const previous = input.figures.filter(
    (f) => fy !== null && f.fy === previousFy(fy) && f.stage === prevStage,
  );
  const programme = (fs: readonly FiscalFigure[]) =>
    new Map(
      fs
        .filter((f) => (PROGRAMME_SECTORS as readonly string[]).includes(f.category))
        .map((f) => [f.category as ProgrammeSector, f.amount]),
    );
  const spend = programme(current);
  const prevSpend = programme(previous);
  const programmeTotal = [...spend.values()].reduce((a, b) => a + b, 0);

  // Attention: every group gated together, so published shares cannot subtract to a suppressed one.
  const groupNames = [...PROGRAMME_SECTORS, ...UNMAPPED_NEEDS];
  const none: GroupFigures = { voices: 0, comments: 0, negative: 0, neutral: 0, positive: 0 };
  // A group the store reports nothing for was raised by nobody — zero, not unknown.
  const figuresOf = (name: string) =>
    input.comments ? (input.comments.groups[name] ?? none) : undefined;
  const attentionGate = applyAnonymityGate(
    { ...emptyRawBucket('all'), n: input.comments?.voices ?? 0 },
    groupNames.map((name) => ({ ...emptyRawBucket(name), n: figuresOf(name)?.voices ?? 0 })),
    { k: input.k },
  );
  const published = new Set(
    attentionGate.buckets.filter((b) => !b.suppressed).map((b) => b.bucket),
  );
  const sectorMentions = PROGRAMME_SECTORS.reduce((t, s) => t + (figuresOf(s)?.comments ?? 0), 0);

  const rows: SectorInsightRow[] = PROGRAMME_SECTORS.map((sector) => {
    const amount = spend.get(sector) ?? null;
    const spendingShare = amount !== null && programmeTotal > 0 ? amount / programmeTotal : null;
    const g = figuresOf(sector);
    const shown = published.has(sector) && g !== undefined;
    const attentionShare = shown && sectorMentions > 0 ? g.comments / sectorMentions : null;
    return {
      sector,
      label: FISCAL_LABELS[sector],
      spending: {
        amount,
        share_of_programmes: spendingShare,
        previous_amount: prevSpend.get(sector) ?? null,
      },
      attention: {
        voices: shown ? g.voices : null,
        comments: shown ? g.comments : null,
        share: attentionShare,
        negative_share: shown && g.comments > 0 ? g.negative / g.comments : null,
        suppressed: !shown,
      },
      mood: sectorMood(
        input.slices.filter((s) => s.sector === sector),
        input.expectedBuckets,
        input.k,
      ),
      attention_minus_spending:
        attentionShare !== null && spendingShare !== null ? attentionShare - spendingShare : null,
    };
  });

  const sources = new Map<string, string>();
  for (const f of current) if (!sources.has(f.source_url)) sources.set(f.source_url, f.source_name);

  return {
    fy,
    stage,
    rows,
    unmapped: UNMAPPED_NEEDS.map((need) => ({
      need,
      label: NEED_LABELS[need],
      comments: published.has(need) ? (figuresOf(need)?.comments ?? 0) : null,
    })),
    provenance: [...new Set(current.map((f) => f.provenance))],
    sources: [...sources.entries()].map(([url, name]) => ({ name, url })),
  };
}
