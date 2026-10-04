import type { RtiDeadline, RtiNextAction, RtiState, RtiTrack } from '@civic-voice/contracts';
import { addDays, daysBetween, today as todayIso } from './time.ts';

/**
 * The RTI Act 2005 statutory clock (docs/RTI.md).
 *
 * Most RTI requests fail not because the information is exempt but because the filer never learns
 * that the deadline passed and that an appeal is free and time-bounded. Modelling the clock
 * correctly is most of this product's value, so it lives here as pure functions over the request's
 * state — cheap to call, and exhaustively testable.
 */

/** §7(1) and its provisos: the window for the PIO to respond. */
export const RESPONSE_WINDOW_DAYS: Record<RtiTrack, number> = {
  /** §7(1) — thirty days from receipt. */
  standard: 30,
  /** §7(1) proviso — forty-eight hours where life or liberty of a person is concerned. */
  life_liberty: 2,
  /** §6(3) transfer to another public authority adds five days to the §7(1) window. */
  transferred: 35,
  /** §11(1)–(3) third-party representation extends the window to forty days. */
  third_party: 40,
};

/** §19(1) — window to file a first appeal, from response or deemed refusal. */
export const FIRST_APPEAL_WINDOW_DAYS = 30;
/** §19(6) — the First Appellate Authority must decide in thirty days, extendable to forty-five. */
export const FA_DECISION_DAYS = 30;
export const FA_DECISION_DAYS_EXTENDED = 45;
/** §19(3) — second appeal to the Information Commission within ninety days. */
export const SECOND_APPEAL_WINDOW_DAYS = 90;

export interface RtiClockInput {
  track: RtiTrack;
  state: RtiState;
  filed_at: string | null;
  responded_at?: string | null;
  first_appeal_at?: string | null;
  fa_responded_at?: string | null;
  second_appeal_at?: string | null;
  /** §19(6) — the FAA recorded reasons for taking the longer forty-five days. */
  fa_extended?: boolean;
}

const TERMINAL: ReadonlySet<RtiState> = new Set(['closed', 'withdrawn']);

/**
 * Legal state transitions. Validated at the API boundary rather than trusted from the client.
 *
 * Two transitions here are easy to miss and both matter:
 *  - `deemed_refused → responded`: an authority may answer late. The clock has already moved on,
 *    but the response is still real and must be recordable.
 *  - `first_appeal → second_appeal`: §19(3) permits a second appeal when the FAA is itself silent,
 *    so a non-responsive appellate authority cannot stall the ladder either.
 */
const TRANSITIONS: Record<RtiState, readonly RtiState[]> = {
  draft: ['filed', 'withdrawn'],
  filed: ['acknowledged', 'responded', 'deemed_refused', 'withdrawn'],
  acknowledged: ['responded', 'deemed_refused', 'withdrawn'],
  responded: ['satisfied', 'first_appeal', 'withdrawn'],
  deemed_refused: ['responded', 'first_appeal', 'withdrawn'],
  satisfied: ['closed'],
  first_appeal: ['fa_responded', 'second_appeal', 'withdrawn'],
  fa_responded: ['satisfied', 'second_appeal', 'withdrawn'],
  second_appeal: ['sic_responded', 'withdrawn'],
  sic_responded: ['satisfied', 'closed'],
  closed: [],
  withdrawn: [],
};

export function canTransition(from: RtiState, to: RtiState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: RtiState): readonly RtiState[] {
  return TRANSITIONS[from];
}

export function isTerminal(state: RtiState): boolean {
  return TERMINAL.has(state);
}

/** §7(1) — when the PIO's response falls due. Null while the request is still a draft. */
export function responseDueOn(input: RtiClockInput): string | null {
  if (!input.filed_at) return null;
  return addDays(input.filed_at, RESPONSE_WINDOW_DAYS[input.track]);
}

/**
 * §19(1) — the last day to file a first appeal: thirty days from the response, or from the day the
 * response fell due if none ever came. Deemed refusal is itself an appealable event (§7(2)), which
 * is exactly why silence cannot stall the process.
 */
export function firstAppealDueOn(input: RtiClockInput): string | null {
  const from = input.responded_at ?? responseDueOn(input);
  if (!from) return null;
  return addDays(from, FIRST_APPEAL_WINDOW_DAYS);
}

/** §19(6) — when the FAA's decision falls due. */
export function faDecisionDueOn(input: RtiClockInput): string | null {
  if (!input.first_appeal_at) return null;
  return addDays(
    input.first_appeal_at,
    input.fa_extended ? FA_DECISION_DAYS_EXTENDED : FA_DECISION_DAYS,
  );
}

/** §19(3) — the last day to file a second appeal with the CIC/SIC. */
export function secondAppealDueOn(input: RtiClockInput): string | null {
  const from = input.fa_responded_at ?? faDecisionDueOn(input);
  if (!from) return null;
  return addDays(from, SECOND_APPEAL_WINDOW_DAYS);
}

/**
 * Has the §7(1) window expired with no response? §7(2) makes that a *deemed refusal* — a refusal
 * in law, appealable on its own. The worker's sweeper advances the state on this, so the platform
 * notices on the citizen's behalf rather than waiting for the citizen to notice.
 */
export function isDeemedRefused(input: RtiClockInput, today = todayIso()): boolean {
  if (input.responded_at) return false;
  if (input.state !== 'filed' && input.state !== 'acknowledged') return false;
  const due = responseDueOn(input);
  return due !== null && daysBetween(due, today) > 0;
}

function deadline(
  label: string,
  statute: string,
  dueOn: string,
  today: string,
  satisfied: boolean,
): RtiDeadline {
  const daysRemaining = daysBetween(today, dueOn);
  return {
    label,
    due_on: dueOn,
    statute,
    breached: !satisfied && daysRemaining < 0,
    days_remaining: daysRemaining,
  };
}

/** Every statutory date that applies to a request, in the order the ladder is climbed. */
export function rtiDeadlines(input: RtiClockInput, today = todayIso()): RtiDeadline[] {
  const out: RtiDeadline[] = [];

  const responseDue = responseDueOn(input);
  if (responseDue) {
    out.push(
      deadline(
        'PIO response due',
        input.track === 'life_liberty' ? 'RTI Act 2005 §7(1) proviso' : 'RTI Act 2005 §7(1)',
        responseDue,
        today,
        input.responded_at !== null && input.responded_at !== undefined,
      ),
    );
  }

  // The first-appeal window only becomes actionable once there is something to appeal: a response
  // the filer is unhappy with, or a refusal (deemed or express).
  const appealable =
    input.state === 'responded' ||
    input.state === 'deemed_refused' ||
    isDeemedRefused(input, today);
  const firstAppealDue = firstAppealDueOn(input);
  if (firstAppealDue && appealable) {
    out.push(
      deadline(
        'Last day to file first appeal',
        'RTI Act 2005 §19(1)',
        firstAppealDue,
        today,
        Boolean(input.first_appeal_at),
      ),
    );
  }

  const faDue = faDecisionDueOn(input);
  if (faDue) {
    out.push(
      deadline(
        'First Appellate Authority decision due',
        'RTI Act 2005 §19(6)',
        faDue,
        today,
        Boolean(input.fa_responded_at),
      ),
    );
  }

  const secondDue = secondAppealDueOn(input);
  if (secondDue && (input.fa_responded_at || (faDue && daysBetween(faDue, today) > 0))) {
    out.push(
      deadline(
        'Last day to file second appeal',
        'RTI Act 2005 §19(3)',
        secondDue,
        today,
        Boolean(input.second_appeal_at),
      ),
    );
  }

  return out;
}

/**
 * What the citizen can do today, and how long they have. This is the single most useful thing the
 * product produces, so it is a pure function and covered case by case in the tests.
 */
export function nextAction(input: RtiClockInput, today = todayIso()): RtiNextAction {
  const find = (label: string) => rtiDeadlines(input, today).find((d) => d.label === label) ?? null;

  if (isTerminal(input.state)) {
    return { action: 'none', deadline: null, explanation: 'This request is closed.' };
  }

  if (input.state === 'draft') {
    return {
      action: 'none',
      deadline: null,
      explanation:
        'File this request with the public authority to start the 30-day statutory clock.',
    };
  }

  if (input.state === 'filed' || input.state === 'acknowledged') {
    if (isDeemedRefused(input, today)) {
      const d = find('Last day to file first appeal');
      return {
        action: 'file_first_appeal',
        deadline: d,
        explanation:
          'The statutory response window expired with no reply. Under §7(2) that is a deemed ' +
          'refusal, and you may file a free first appeal under §19(1).',
      };
    }
    const d = find('PIO response due');
    return {
      action: 'await_response',
      deadline: d,
      explanation: `The Public Information Officer has ${d?.days_remaining ?? 0} day(s) left to respond.`,
    };
  }

  if (input.state === 'responded' || input.state === 'deemed_refused') {
    const d = find('Last day to file first appeal');
    return {
      action: 'file_first_appeal',
      deadline: d,
      explanation:
        d && d.breached
          ? 'The §19(1) appeal window has closed. You may still file a fresh request, or approach ' +
            'the Information Commission for condonation of delay with reasons.'
          : 'If the reply is incomplete, misleading or refused, you may file a free first appeal ' +
            'with the First Appellate Authority under §19(1).',
    };
  }

  if (input.state === 'first_appeal') {
    const d = find('First Appellate Authority decision due');
    if (d && d.breached) {
      return {
        action: 'file_second_appeal',
        deadline: find('Last day to file second appeal'),
        explanation:
          'The First Appellate Authority did not decide within the §19(6) window. You may file a ' +
          'second appeal with the Information Commission under §19(3).',
      };
    }
    return {
      action: 'await_fa_response',
      deadline: d,
      explanation: `The First Appellate Authority has ${d?.days_remaining ?? 0} day(s) left to decide.`,
    };
  }

  if (input.state === 'fa_responded') {
    return {
      action: 'file_second_appeal',
      deadline: find('Last day to file second appeal'),
      explanation:
        'If the first appeal did not resolve the matter, you may file a second appeal with the ' +
        'Central or State Information Commission under §19(3).',
    };
  }

  if (input.state === 'second_appeal') {
    return {
      action: 'await_sic_response',
      deadline: null,
      explanation:
        'The Information Commission has no statutory decision deadline. Typical disposal takes ' +
        'months to years depending on the Commission’s backlog.',
    };
  }

  // satisfied | sic_responded
  return { action: 'close', deadline: null, explanation: 'You can close this request.' };
}
