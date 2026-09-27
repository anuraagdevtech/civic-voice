import { isDeemedRefused, nextAction, today, type RtiClockInput } from '@civic-voice/core';
import type { RtiRequestRow } from '@civic-voice/db';
import type { ShardRouter } from '@civic-voice/db';
import { forEachShardCluster, vshardBucket } from '@civic-voice/db/maintenance';
import type { AnalyticsStore, RtiOutcomeRow } from '@civic-voice/analytics';
import type { Logger, Metrics } from '@civic-voice/observability';

/**
 * The RTI deadline sweeper (docs/RTI.md §3).
 *
 * Most RTI requests fail because nobody notices the deadline passed. This is the job that notices on
 * the citizen's behalf: it advances `filed → deemed_refused` where §7(2) does so automatically, and
 * emits a notification carrying the concrete next step, the deadline, and the correct First Appellate
 * Authority.
 *
 * It is the one legitimate cross-shard reader in the system, so it goes through the separate
 * maintenance entry point (ADR-0007) — and it is **time-bucketed**: each tick covers one slice of the
 * vshard range, so the work per tick is bounded rather than a full scan of 50M rows.
 */

export interface SweepNotification {
  citizenId: string;
  requestId: string;
  authorityId: number;
  action: string;
  deadline: string | null;
  explanation: string;
}

export interface SweepResult {
  scanned: number;
  advanced: number;
  notifications: SweepNotification[];
}

export interface RtiSweeperDeps {
  router: ShardRouter;
  analytics: AnalyticsStore;
  metrics: Metrics;
  logger: Logger;
  /** How many buckets a full cycle is split into. 24 with an hourly tick covers the fleet daily. */
  buckets?: number;
  /** Delivers the notification. Injected so the sweeper itself stays testable and side-effect free. */
  notify?: (notification: SweepNotification) => Promise<void>;
}

const OPEN_STATES = ['filed', 'acknowledged'] as const;

export class RtiSweeper {
  private readonly deps: RtiSweeperDeps;

  constructor(deps: RtiSweeperDeps) {
    this.deps = deps;
  }

  async sweep(tick: number, asOf = today()): Promise<SweepResult> {
    const { from, to } = vshardBucket(tick, this.deps.buckets ?? 24);
    let scanned = 0;
    let advanced = 0;
    const notifications: SweepNotification[] = [];

    await forEachShardCluster(this.deps.router, async ({ clusterId, db }) => {
      // Uses the partial index on open requests with a filing date, so the scan is over the rows whose
      // clock is actually running — not over every request ever filed.
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT r.id, r.citizen_id, r.authority_id, r.track, r.state, r.filed_at,
                r.responded_at, r.first_appeal_at, r.fa_responded_at, r.second_appeal_at, r.fa_extended
         FROM civic_shard.rti_request r
         JOIN civic_shard.citizen c ON c.id = r.citizen_id
         WHERE c.vshard >= $1 AND c.vshard < $2
           AND r.state = ANY($3::text[])
           AND r.filed_at IS NOT NULL
           AND r.responded_at IS NULL
         LIMIT 5000`,
        [from, to, [...OPEN_STATES]],
      );
      scanned += rows.length;

      for (const row of rows) {
        const clock: RtiClockInput = {
          track: String(row['track']) as RtiClockInput['track'],
          state: String(row['state']) as RtiClockInput['state'],
          filed_at: asDate(row['filed_at']),
          responded_at: asDate(row['responded_at']),
          first_appeal_at: asDate(row['first_appeal_at']),
          fa_responded_at: asDate(row['fa_responded_at']),
          second_appeal_at: asDate(row['second_appeal_at']),
          fa_extended: Boolean(row['fa_extended']),
        };
        if (!isDeemedRefused(clock, asOf)) continue;

        await db.query(
          `UPDATE civic_shard.rti_request SET state = 'deemed_refused', updated_at = now()
           WHERE id = $1 AND state = ANY($2::text[])`,
          [row['id'], [...OPEN_STATES]],
        );
        advanced += 1;

        const action = nextAction({ ...clock, state: 'deemed_refused' }, asOf);
        notifications.push({
          citizenId: String(row['citizen_id']),
          requestId: String(row['id']),
          authorityId: Number(row['authority_id']),
          action: action.action,
          deadline: action.deadline?.due_on ?? null,
          explanation: action.explanation,
        });
      }

      this.deps.logger.debug({ clusterId, from, to, scanned: rows.length }, 'swept vshard bucket');
    });

    // The authority's public compliance scorecard is computed from these (docs/RTI.md §4). Written to
    // the analytical store with no filer identity attached — §8(1)(j) cuts both ways.
    const outcomes: RtiOutcomeRow[] = notifications.map((n) => ({
      authorityId: n.authorityId,
      filedOn: asOf,
      closedOn: null,
      track: 'standard',
      finalState: 'deemed_refused',
      responseDays: null,
      deemedRefused: true,
      firstAppealed: false,
      appealOverturned: false,
      exemptionClause: '',
    }));
    if (outcomes.length > 0) await this.deps.analytics.insertRtiOutcomes(outcomes);

    if (this.deps.notify) {
      for (const notification of notifications) {
        try {
          await this.deps.notify(notification);
        } catch (err) {
          // A failed notification must not abort the sweep: the state change is already persisted, and
          // the citizen will see it next time they open the app.
          this.deps.logger.error(
            { err, request_id: notification.requestId },
            'notification failed',
          );
        }
      }
    }

    if (advanced > 0) {
      this.deps.metrics.inc('civic_rti_deadline_transitions_total', {}, advanced);
      this.deps.logger.info({ tick, from, to, scanned, advanced }, 'RTI deadlines swept');
    }
    return { scanned, advanced, notifications };
  }

  /** Pure helper, used by tests and by the API's view: which rows have lapsed. */
  static lapsed(rows: readonly RtiRequestRow[], asOf = today()): RtiRequestRow[] {
    return rows.filter(
      (row) =>
        row.state !== 'deemed_refused' &&
        isDeemedRefused(
          {
            track: row.track,
            state: row.state,
            filed_at: row.filed_at,
            responded_at: row.responded_at,
            first_appeal_at: row.first_appeal_at,
            fa_responded_at: row.fa_responded_at,
            second_appeal_at: row.second_appeal_at,
            fa_extended: row.fa_extended,
          },
          asOf,
        ),
    );
  }
}

function asDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}
