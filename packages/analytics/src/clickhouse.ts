import { createClient, type ClickHouseClient } from '@clickhouse/client';
import type { AnalyticsEvent, VerificationTier } from '@civic-voice/contracts';
import { dayOf, fromHistogram, rollupAncestors, type RawBucket } from '@civic-voice/core';
import { encodeDemographicsForAnalytics, encodeReasonCodeForAnalytics } from './encode.ts';
import type {
  AnalyticsStore,
  CrossSliceQuery,
  DailyRollupRow,
  RtiOutcomeRow,
  ScorecardResult,
  SeriesPoint,
} from './ports.ts';

/**
 * ClickHouse-backed analytics store.
 *
 * Every write here is a batch insert. At 150M events a day, per-row inserts would create a part per
 * row and the merge scheduler would never catch up — "too many parts" is the canonical way to take a
 * ClickHouse cluster down, and it is a client-side mistake, not a server limit.
 */

const DIMENSION_COLUMN: Record<string, string> = {
  age_band: 'age_band',
  gender: 'gender',
  urbanity: 'urbanity',
  income_band: 'income_band',
  education_band: 'education_band',
  occupation_band: 'occupation_band',
};

export interface ClickHouseOptions {
  url?: string;
  username?: string;
  password?: string;
  database?: string;
}

export class ClickHouseAnalyticsStore implements AnalyticsStore {
  private readonly client: ClickHouseClient;
  private readonly database: string;

  constructor(opts: ClickHouseOptions = {}) {
    this.database = opts.database ?? process.env['CLICKHOUSE_DB'] ?? 'civic';
    this.client = createClient({
      url: opts.url ?? process.env['CLICKHOUSE_URL'] ?? 'http://127.0.0.1:8123',
      username: opts.username ?? process.env['CLICKHOUSE_USER'] ?? 'civic',
      password: opts.password ?? process.env['CLICKHOUSE_PASSWORD'] ?? 'civic',
      database: this.database,
      clickhouse_settings: {
        // Let the server batch small inserts on our behalf as a second line of defence against
        // part explosion, in case a caller ever inserts a short batch in a loop.
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });
  }

  async insertEvents(events: readonly AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.client.insert({
      table: 'sentiment_event',
      format: 'JSONEachRow',
      values: events.map((e) => {
        const [country = 0, state = 0, district = 0, constituency = 0] = rollupAncestors(e.region_path);
        const bands = encodeDemographicsForAnalytics(e.demographics);
        return {
          event_id: e.event_id,
          occurred_at: e.occurred_at.replace('T', ' ').replace('Z', ''),
          topic_id: e.topic_id,
          region_country: country,
          region_state: state,
          region_district: district,
          region_constituency: constituency,
          pseudonym: e.pseudonym,
          verification_tier: e.verification_tier,
          ...bands,
          mood: e.mood,
          intensity: e.intensity,
          reason_code: encodeReasonCodeForAnalytics(e.reason_code),
          delta: e.delta,
        };
      }),
    });
  }

  async insertRollups(rows: readonly DailyRollupRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.client.insert({
      table: 'mood_rollup',
      format: 'JSONEachRow',
      values: rows.map((r) => ({
        day: r.day,
        topic_id: r.topicId,
        region_id: r.regionId,
        dim: r.dim,
        bucket: r.bucket,
        tier: r.tier,
        n: r.n,
        sum_intensity: r.sumIntensity,
        h_angry: r.histogram[0],
        h_concerned: r.histogram[1],
        h_neutral: r.histogram[2],
        h_hopeful: r.histogram[3],
        h_satisfied: r.histogram[4],
      })),
    });
  }

  async series(
    topicId: number,
    regionId: number,
    dim: number,
    bucket: string,
    tiers: readonly VerificationTier[],
    from: string,
    to: string,
  ): Promise<SeriesPoint[]> {
    const result = await this.client.query({
      query: `
        SELECT day,
               sum(n) AS n,
               sum(h_angry) AS h0, sum(h_concerned) AS h1, sum(h_neutral) AS h2,
               sum(h_hopeful) AS h3, sum(h_satisfied) AS h4
        FROM mood_rollup
        WHERE topic_id = {topicId:UInt64} AND region_id = {regionId:UInt64}
          AND dim = {dim:UInt8} AND bucket = {bucket:String}
          AND tier IN ({tiers:Array(UInt8)})
          AND day BETWEEN {from:Date} AND {to:Date}
        GROUP BY day ORDER BY day`,
      query_params: { topicId, regionId, dim, bucket, tiers: [...tiers], from, to },
      format: 'JSONEachRow',
    });
    const rows = await result.json<Record<string, string | number>>();
    return rows.map((row) => {
      const histogram = [0, 1, 2, 3, 4].map((i) => Number(row[`h${i}`])) as SeriesPoint['histogram'];
      const n = Number(row['n']);
      const rebuilt = fromHistogram(bucket, histogram);
      return {
        day: String(row['day']),
        n,
        meanMood: n > 0 ? Math.round((rebuilt.sumMood / n) * 100) / 100 : null,
        histogram,
      };
    });
  }

  async recomputeSlice(
    topicId: number,
    regionId: number,
    dim: number,
    tier: VerificationTier,
  ): Promise<RawBucket[]> {
    const result = await this.client.query({
      query: `
        SELECT bucket,
               sum(sum_intensity) AS sum_intensity,
               sum(h_angry) AS h0, sum(h_concerned) AS h1, sum(h_neutral) AS h2,
               sum(h_hopeful) AS h3, sum(h_satisfied) AS h4
        FROM mood_rollup
        WHERE topic_id = {topicId:UInt64} AND region_id = {regionId:UInt64}
          AND dim = {dim:UInt8} AND tier = {tier:UInt8}
        GROUP BY bucket`,
      query_params: { topicId, regionId, dim, tier },
      format: 'JSONEachRow',
    });
    const rows = await result.json<Record<string, string | number>>();
    return rows.map((row) =>
      fromHistogram(
        String(row['bucket']),
        [0, 1, 2, 3, 4].map((i) => Number(row[`h${i}`])) as never,
        Number(row['sum_intensity']),
      ),
    );
  }

  /**
   * The gated cross-product path (ADR-0002). Computed on demand rather than pre-computed, forced
   * through the k-anonymity gate by the caller, rate-limited per API key and cached by query hash.
   */
  async crossSlice(query: CrossSliceQuery): Promise<RawBucket> {
    const conditions: string[] = [
      'topic_id = {topicId:UInt64}',
      '(region_country = {regionId:UInt64} OR region_state = {regionId:UInt64} ' +
        'OR region_district = {regionId:UInt64} OR region_constituency = {regionId:UInt64})',
      'verification_tier IN ({tiers:Array(UInt8)})',
    ];
    const params: Record<string, unknown> = {
      topicId: query.topicId,
      regionId: query.regionId,
      tiers: [...query.tiers],
    };

    for (const [dim, value] of Object.entries(query.where)) {
      const column = DIMENSION_COLUMN[dim];
      // Column names come from a closed allow-list keyed by the validated dimension enum, never
      // interpolated from a request.
      if (column === undefined || value === undefined) continue;
      conditions.push(`${column} = {band_${column}:UInt8}`);
      params[`band_${column}`] = value;
    }
    if (query.from) {
      conditions.push('occurred_at >= {from:DateTime}');
      params['from'] = `${query.from} 00:00:00`;
    }
    if (query.to) {
      conditions.push('occurred_at <= {to:DateTime}');
      params['to'] = `${query.to} 23:59:59`;
    }

    const result = await this.client.query({
      query: `
        SELECT
          sumIf(delta, mood = -2) AS h0, sumIf(delta, mood = -1) AS h1,
          sumIf(delta, mood =  0) AS h2, sumIf(delta, mood =  1) AS h3,
          sumIf(delta, mood =  2) AS h4,
          sum(intensity * delta) AS sum_intensity
        FROM sentiment_event WHERE ${conditions.join(' AND ')}`,
      query_params: params,
      format: 'JSONEachRow',
    });
    const [row] = await result.json<Record<string, string | number>>();
    const histogram = [0, 1, 2, 3, 4].map((i) => Math.max(0, Number(row?.[`h${i}`] ?? 0)));
    return fromHistogram('cross', histogram as never, Math.max(0, Number(row?.['sum_intensity'] ?? 0)));
  }

  async participants(topicId: number, regionId: number, day: string): Promise<number> {
    const result = await this.client.query({
      query: `
        SELECT uniqMerge(participants) AS n FROM participation_daily
        WHERE topic_id = {topicId:UInt64} AND region_id = {regionId:UInt64} AND day = {day:Date}`,
      query_params: { topicId, regionId, day },
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{ n: string }>();
    return Number(row?.n ?? 0);
  }

  async insertRtiOutcomes(rows: readonly RtiOutcomeRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.client.insert({
      table: 'rti_outcome',
      format: 'JSONEachRow',
      values: rows.map((r) => ({
        authority_id: r.authorityId,
        filed_on: r.filedOn,
        closed_on: r.closedOn,
        track: r.track,
        final_state: r.finalState,
        response_days: r.responseDays,
        deemed_refused: r.deemedRefused ? 1 : 0,
        first_appealed: r.firstAppealed ? 1 : 0,
        appeal_overturned: r.appealOverturned ? 1 : 0,
        exemption_clause: r.exemptionClause,
      })),
    });
  }

  async authorityScorecard(authorityId: number, windowDays: number): Promise<ScorecardResult> {
    const result = await this.client.query({
      query: `
        SELECT
          count()                                          AS requests,
          countIf(response_days IS NOT NULL AND deemed_refused = 0) AS on_time,
          median(response_days)                            AS median_days,
          countIf(deemed_refused = 1)                      AS refused,
          countIf(first_appealed = 1)                      AS appealed,
          countIf(appeal_overturned = 1)                   AS overturned
        FROM rti_outcome
        WHERE authority_id = {authorityId:UInt64}
          AND filed_on >= today() - {windowDays:UInt16}`,
      query_params: { authorityId, windowDays },
      format: 'JSONEachRow',
    });
    const [row] = await result.json<Record<string, string | number | null>>();
    const requests = Number(row?.['requests'] ?? 0);
    if (requests === 0) {
      return {
        authorityId, requests: 0, onTimeRate: null, medianResponseDays: null,
        deemedRefusalRate: null, firstAppealRate: null, appealOverturnRate: null,
      };
    }
    const appealed = Number(row?.['appealed'] ?? 0);
    const rate = (n: number) => Math.round((n / requests) * 1000) / 1000;
    return {
      authorityId,
      requests,
      onTimeRate: rate(Number(row?.['on_time'] ?? 0)),
      medianResponseDays: row?.['median_days'] === null ? null : Number(row?.['median_days']),
      deemedRefusalRate: rate(Number(row?.['refused'] ?? 0)),
      firstAppealRate: rate(appealed),
      appealOverturnRate:
        appealed === 0 ? null : Math.round((Number(row?.['overturned'] ?? 0) / appealed) * 1000) / 1000,
    };
  }

  async ready(): Promise<void> {
    await this.client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function createClickHouseAnalyticsStore(opts: ClickHouseOptions = {}): ClickHouseAnalyticsStore {
  return new ClickHouseAnalyticsStore(opts);
}

export { dayOf };
