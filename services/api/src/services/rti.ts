import type { RtiState, RtiTrack } from '@civic-voice/contracts';
import {
  canTransition,
  invalidTransition,
  isDeemedRefused,
  nextAction,
  notFound,
  rtiDeadlines,
  today,
  uuidv7,
  type RtiClockInput,
} from '@civic-voice/core';
import type { Repositories, RtiRequestRow } from '@civic-voice/db';

/**
 * RTI request lifecycle (docs/RTI.md).
 *
 * The statutory clock lives in @civic-voice/core as pure functions; this layer persists state and
 * enforces that a transition is legal before it is stored. Legality is checked here rather than
 * trusted from the client, because a client that skips `deemed_refused` would silently lose the
 * citizen's appeal rights.
 */

export class RtiService {
  private readonly repos: Repositories;

  constructor(repos: Repositories) {
    this.repos = repos;
  }

  private clockInput(row: RtiRequestRow): RtiClockInput {
    return {
      track: row.track,
      state: row.state,
      filed_at: row.filed_at,
      responded_at: row.responded_at,
      first_appeal_at: row.first_appeal_at,
      fa_responded_at: row.fa_responded_at,
      second_appeal_at: row.second_appeal_at,
      fa_extended: row.fa_extended,
    };
  }

  /**
   * A request with its deadlines and the one thing the citizen can do next.
   *
   * The state is reported as `deemed_refused` the moment the statutory window lapses, even before the
   * sweeper has written it. Otherwise a citizen who opens the app at the right moment would be told to
   * keep waiting on a request that is already appealable — and the appeal window is itself only 30
   * days (§19(1)).
   */
  view(row: RtiRequestRow, asOf = today()) {
    const clock = this.clockInput(row);
    const effective: RtiRequestRow =
      isDeemedRefused(clock, asOf) && row.state !== 'deemed_refused'
        ? { ...row, state: 'deemed_refused' }
        : row;

    return {
      request: effective,
      deadlines: rtiDeadlines(clock, asOf),
      next_action: nextAction(clock, asOf),
    };
  }

  async create(
    citizenId: string,
    input: { authority_id: number; topic_id: number | null; subject: string; track: RtiTrack; filed_at?: string },
  ) {
    const authority = await this.repos.catalogue.getAuthority(input.authority_id);
    if (!authority) throw notFound(`no authority ${input.authority_id}`);

    const row = await this.repos.rti.create({
      id: uuidv7(),
      citizen_id: citizenId,
      authority_id: input.authority_id,
      topic_id: input.topic_id,
      subject: input.subject,
      track: input.track,
      filed_at: input.filed_at ?? null,
      acknowledged_at: null,
      responded_at: null,
      first_appeal_at: null,
      fa_responded_at: null,
      fa_extended: false,
      second_appeal_at: null,
    });
    return this.view(row);
  }

  async get(citizenId: string, id: string) {
    const row = await this.repos.rti.findById(citizenId, id);
    if (!row) throw notFound('no such RTI request');
    return this.view(row);
  }

  async list(citizenId: string) {
    const rows = await this.repos.rti.listByCitizen(citizenId);
    return rows.map((row) => this.view(row));
  }

  async transition(citizenId: string, id: string, to: RtiState, on?: string) {
    const row = await this.repos.rti.findById(citizenId, id);
    if (!row) throw notFound('no such RTI request');

    // Transition from the *effective* state, so a citizen whose request has lapsed into deemed
    // refusal can file the first appeal the statute entitles them to, even though the stored state
    // still says `filed`.
    const effectiveState = this.view(row).request.state;
    if (!canTransition(effectiveState, to)) throw invalidTransition(effectiveState, to);

    // Persist the intermediate lapse too, so the record shows the refusal the appeal answers.
    if (effectiveState !== row.state) {
      await this.repos.rti.transition(citizenId, id, effectiveState, null);
    }

    const updated = await this.repos.rti.transition(citizenId, id, to, on ?? null);
    if (!updated) throw notFound('no such RTI request');
    return this.view(updated);
  }

  /**
   * Requests whose statutory window has lapsed since the last sweep. Called by the worker, which
   * advances the state and notifies the citizen with a pre-filled appeal — the platform notices on
   * their behalf, which is the whole point (docs/RTI.md §3).
   */
  lapsed(rows: readonly RtiRequestRow[], asOf = today()): RtiRequestRow[] {
    return rows.filter(
      (row) => row.state !== 'deemed_refused' && isDeemedRefused(this.clockInput(row), asOf),
    );
  }
}
