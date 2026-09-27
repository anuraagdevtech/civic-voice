import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedTransitions,
  canTransition,
  faDecisionDueOn,
  firstAppealDueOn,
  isDeemedRefused,
  isTerminal,
  nextAction,
  responseDueOn,
  rtiDeadlines,
  secondAppealDueOn,
  type RtiClockInput,
} from '../src/rti.ts';
import { RTI_STATES } from '@civic-voice/contracts';

const filed = (over: Partial<RtiClockInput> = {}): RtiClockInput => ({
  track: 'standard',
  state: 'filed',
  filed_at: '2026-01-01',
  responded_at: null,
  first_appeal_at: null,
  fa_responded_at: null,
  second_appeal_at: null,
  ...over,
});

describe('RTI statutory clock', () => {
  test('§7(1): a standard request is due in 30 days', () => {
    assert.equal(responseDueOn(filed()), '2026-01-31');
  });

  test('§7(1) proviso: life or liberty is due in 48 hours', () => {
    assert.equal(responseDueOn(filed({ track: 'life_liberty' })), '2026-01-03');
  });

  test('§6(3): a transferred request gets the extra 5 days', () => {
    assert.equal(responseDueOn(filed({ track: 'transferred' })), '2026-02-05');
  });

  test('§11: third-party representation extends the window to 40 days', () => {
    assert.equal(responseDueOn(filed({ track: 'third_party' })), '2026-02-10');
  });

  test('a draft has no deadlines, because the clock starts on filing', () => {
    const draft = filed({ state: 'draft', filed_at: null });
    assert.equal(responseDueOn(draft), null);
    assert.deepEqual(rtiDeadlines(draft, '2026-02-01'), []);
    assert.equal(nextAction(draft, '2026-02-01').action, 'none');
  });

  test('§7(2): silence past the window is a deemed refusal', () => {
    assert.equal(isDeemedRefused(filed(), '2026-01-31'), false, 'not yet — due today');
    assert.equal(isDeemedRefused(filed(), '2026-02-01'), true, 'one day past due');
  });

  test('a request that was answered is never deemed refused, even late', () => {
    assert.equal(
      isDeemedRefused(filed({ responded_at: '2026-03-15' }), '2026-06-01'),
      false,
    );
  });

  test('§19(1): the appeal window runs from deemed refusal when no reply came', () => {
    // Due 2026-01-31, so the appeal window closes 30 days later.
    assert.equal(firstAppealDueOn(filed()), '2026-03-02');
  });

  test('§19(1): the appeal window runs from the actual reply when one came', () => {
    assert.equal(firstAppealDueOn(filed({ responded_at: '2026-01-20' })), '2026-02-19');
  });

  test('§19(6): the FAA has 30 days, or 45 with recorded reasons', () => {
    const appealed = filed({ state: 'first_appeal', first_appeal_at: '2026-03-01' });
    assert.equal(faDecisionDueOn(appealed), '2026-03-31');
    assert.equal(faDecisionDueOn({ ...appealed, fa_extended: true }), '2026-04-15');
  });

  test('§19(3): the second-appeal window runs from the FAA deadline when the FAA is silent', () => {
    const appealed = filed({ state: 'first_appeal', first_appeal_at: '2026-03-01' });
    assert.equal(secondAppealDueOn(appealed), '2026-06-29'); // 2026-03-31 + 90
  });

  test('§19(3): and from the FAA decision when one was given', () => {
    const responded = filed({
      state: 'fa_responded',
      first_appeal_at: '2026-03-01',
      fa_responded_at: '2026-03-10',
    });
    assert.equal(secondAppealDueOn(responded), '2026-06-08');
  });

  test('deadlines are marked breached only while the corresponding step is still undone', () => {
    const overdue = rtiDeadlines(filed(), '2026-02-10');
    const pio = overdue.find((d) => d.label === 'PIO response due');
    assert.equal(pio?.breached, true);
    assert.equal(pio?.days_remaining, -10);

    const answered = rtiDeadlines(filed({ responded_at: '2026-02-05', state: 'responded' }), '2026-02-10');
    assert.equal(answered.find((d) => d.label === 'PIO response due')?.breached, false);
  });

  test('the appeal window is not surfaced before there is anything to appeal', () => {
    const early = rtiDeadlines(filed(), '2026-01-10').map((d) => d.label);
    assert.deepEqual(early, ['PIO response due']);
  });
});

describe('RTI next action', () => {
  test('while the window is open, wait — and say how long is left', () => {
    const a = nextAction(filed(), '2026-01-21');
    assert.equal(a.action, 'await_response');
    assert.equal(a.deadline?.days_remaining, 10);
    assert.match(a.explanation, /10 day/);
  });

  test('on deemed refusal, the citizen is pushed to a free first appeal', () => {
    const a = nextAction(filed(), '2026-02-05');
    assert.equal(a.action, 'file_first_appeal');
    assert.equal(a.deadline?.due_on, '2026-03-02');
    assert.match(a.explanation, /§7\(2\)/);
    assert.match(a.explanation, /§19\(1\)/);
  });

  test('once the §19(1) window has closed, the advice changes rather than vanishing', () => {
    const a = nextAction(filed({ state: 'deemed_refused' }), '2026-05-01');
    assert.equal(a.action, 'file_first_appeal');
    assert.equal(a.deadline?.breached, true);
    assert.match(a.explanation, /condonation of delay/);
  });

  test('a silent FAA does not stall the ladder: §19(3) opens up', () => {
    const appealed = filed({ state: 'first_appeal', first_appeal_at: '2026-03-01' });
    assert.equal(nextAction(appealed, '2026-03-20').action, 'await_fa_response');
    const a = nextAction(appealed, '2026-04-10');
    assert.equal(a.action, 'file_second_appeal');
    assert.match(a.explanation, /§19\(3\)/);
  });

  test('the Commission has no statutory clock, and we say so rather than inventing one', () => {
    const a = nextAction(filed({ state: 'second_appeal', second_appeal_at: '2026-07-01' }), '2027-01-01');
    assert.equal(a.action, 'await_sic_response');
    assert.equal(a.deadline, null);
  });

  test('terminal states have nothing left to do', () => {
    for (const state of ['closed', 'withdrawn'] as const) {
      assert.equal(nextAction(filed({ state }), '2026-06-01').action, 'none');
    }
  });
});

describe('RTI state machine', () => {
  test('a late response is recordable after a deemed refusal', () => {
    assert.ok(canTransition('deemed_refused', 'responded'));
  });

  test('a second appeal may be filed straight from a silent first appeal', () => {
    assert.ok(canTransition('first_appeal', 'second_appeal'));
  });

  test('illegal shortcuts are rejected', () => {
    assert.equal(canTransition('draft', 'responded'), false);
    assert.equal(canTransition('filed', 'first_appeal'), false);
    assert.equal(canTransition('responded', 'second_appeal'), false);
    assert.equal(canTransition('closed', 'filed'), false);
  });

  test('withdrawal is available from every non-terminal state', () => {
    for (const state of RTI_STATES) {
      if (isTerminal(state) || state === 'satisfied' || state === 'sic_responded') continue;
      assert.ok(canTransition(state, 'withdrawn'), `${state} should allow withdrawal`);
    }
  });

  test('terminal states are dead ends', () => {
    assert.deepEqual(allowedTransitions('closed'), []);
    assert.deepEqual(allowedTransitions('withdrawn'), []);
  });

  test('every state is reachable from draft', () => {
    const seen = new Set(['draft']);
    const queue = ['draft'] as const satisfies readonly string[];
    const work: string[] = [...queue];
    while (work.length > 0) {
      const s = work.pop()!;
      for (const next of allowedTransitions(s as never)) {
        if (!seen.has(next)) {
          seen.add(next);
          work.push(next);
        }
      }
    }
    for (const state of RTI_STATES) {
      assert.ok(seen.has(state), `${state} is unreachable from draft`);
    }
  });
});
