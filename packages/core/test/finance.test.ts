import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FiscalCategory, FiscalStage } from '@civic-voice/contracts';
import {
  availableYears,
  bestStage,
  previousFy,
  summariseFinance,
  type FiscalFigure,
} from '../src/finance.ts';

const fig = (
  category: FiscalCategory,
  amount: number,
  over: Partial<FiscalFigure> = {},
): FiscalFigure => ({
  region_id: 1,
  fy: '2025-26',
  stage: 'BE',
  category,
  amount,
  source_name: 'Budget at a Glance',
  source_url: 'https://www.indiabudget.gov.in/',
  provenance: 'official',
  ...over,
});

/** A small Union-shaped budget that balances exactly: receipts 1,000 = spending 1,000. */
function union(stage: FiscalStage = 'BE', fy = '2025-26', scale = 1): FiscalFigure[] {
  const at = (c: FiscalCategory, n: number) => fig(c, n * scale, { stage, fy });
  return [
    at('income_tax', 220),
    at('corporate_tax', 170),
    at('gst', 180),
    at('customs', 40),
    at('excise', 50),
    at('non_tax_revenue', 90),
    at('non_debt_capital', 10),
    at('borrowing', 240),
    at('transfers_to_states', 300),
    at('interest', 200),
    at('defence', 80),
    at('infrastructure', 150),
    at('health', 20),
    at('education', 25),
    at('subsidies_welfare', 60),
    at('pensions', 40),
    at('administration_other', 125),
  ];
}

describe('finance: periods and stages', () => {
  test('the previous financial year', () => {
    assert.equal(previousFy('2025-26'), '2024-25');
    assert.equal(previousFy('2000-01'), '1999-00');
  });

  test('the most final stage wins: actual, then revised, then budget', () => {
    const figures = [
      ...union('BE'),
      ...union('RE'),
      ...union('BE', '2024-25'),
      ...union('actual', '2024-25'),
    ];
    assert.equal(bestStage(figures, '2025-26'), 'RE');
    assert.equal(bestStage(figures, '2024-25'), 'actual');
    assert.equal(bestStage(figures, '2023-24'), null);
    assert.deepEqual(availableYears(figures), [
      { fy: '2025-26', stages: ['BE', 'RE'] },
      { fy: '2024-25', stages: ['BE', 'actual'] },
    ]);
  });
});

describe('finance: taxes, spending and the gap', () => {
  const s = summariseFinance(union(), { population: 1_400_000_000 });
  assert.ok(s);

  test('taxes by category, largest first, with shares that sum to one', () => {
    assert.equal(s.taxes.total, 660);
    assert.deepEqual(
      s.taxes.items.map((i) => i.category),
      ['income_tax', 'gst', 'corporate_tax', 'excise', 'customs'],
    );
    const total = s.taxes.items.reduce((t, i) => t + i.share, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.equal(s.taxes.items[0]?.label, 'Income tax');
  });

  test('spending by sector, with committed spending marked rather than hidden', () => {
    assert.equal(s.spending.total, 1_000);
    const interest = s.spending.items.find((i) => i.category === 'interest');
    assert.equal(interest?.committed, true);
    assert.equal(s.spending.items.find((i) => i.category === 'health')?.committed, false);
    assert.equal(s.spending.items[0]?.category, 'transfers_to_states');
  });

  test('the gap is spending minus taxes, and each rupee spent is accounted for', () => {
    assert.equal(s.gap.amount, 340);
    assert.equal(s.gap.taxes_cover, 0.66);
    assert.deepEqual(
      s.gap.per_rupee.map((p) => [p.group, p.share]),
      [
        ['taxes', 0.66],
        ['borrowing', 0.24],
        ['other_own', 0.1],
      ],
    );
    assert.equal(s.gap.residual, 0);
    assert.equal(s.gap.reconciles, true);
    assert.match(s.gap.explanation, /66p of every rupee spent/);
    assert.match(s.gap.explanation, /borrowing 24p/);
    assert.equal(
      s.gap.explanation,
      'In 2025-26 (budget estimate), taxes collected paid for 66p of every rupee spent. The other 34p came from: borrowing 24p, other own receipts 10p.',
    );
  });

  test('per-capita figures in rupees when the population is known', () => {
    // ₹660 crore over 1.4B people = ₹4.71 → 5.
    assert.equal(s.taxes.per_capita, 5);
    const noPop = summariseFinance(union(), { population: null });
    assert.equal(noPop?.taxes.per_capita, null);
  });

  test("the Union's gross taxes are explained, since the states' share is passed on", () => {
    assert.ok(s.notes.some((n) => /states' share/.test(n)));
  });
});

describe('finance: figures that do not add up are shown as such', () => {
  test('without a published borrowing figure the shortfall is not assumed to be borrowing', () => {
    const s = summariseFinance(
      union().filter((f) => f.category !== 'borrowing'),
      { population: null },
    );
    const gap = s?.gap.per_rupee.find((p) => p.group === 'unexplained');
    assert.equal(gap?.amount, 240);
    assert.match(gap?.label ?? '', /borrowing not published/);
    assert.equal(s?.gap.residual, null);
    assert.equal(s?.gap.reconciles, false);
  });

  test('a residual beyond 2% of spending is flagged and shown, not absorbed', () => {
    const figures = union().map((f) => (f.category === 'borrowing' ? { ...f, amount: 200 } : f));
    const s = summariseFinance(figures, { population: null });
    assert.equal(s?.gap.residual, -40);
    assert.equal(s?.gap.reconciles, false);
    assert.equal(s?.gap.per_rupee.find((p) => p.group === 'unexplained')?.amount, 40);
    assert.ok(s?.notes.some((n) => /differ by ₹40 crore \(4\.0% of spending\)/.test(n)));
  });

  test('a small residual within tolerance reconciles', () => {
    const figures = union().map((f) => (f.category === 'borrowing' ? { ...f, amount: 230 } : f));
    const s = summariseFinance(figures, { population: null });
    assert.equal(s?.gap.residual, -10);
    assert.equal(s?.gap.reconciles, true);
    assert.equal(
      s?.gap.per_rupee.find((p) => p.group === 'unexplained'),
      undefined,
    );
  });
});

describe('finance: a state', () => {
  const state: FiscalFigure[] = [
    fig('gst', 50, { region_id: 2 }),
    fig('stamp_registration', 15, { region_id: 2 }),
    fig('excise', 20, { region_id: 2 }),
    fig('sales_tax_vat', 25, { region_id: 2 }),
    fig('tax_devolution_received', 30, { region_id: 2 }),
    fig('grants_received', 20, { region_id: 2 }),
    fig('non_tax_revenue', 10, { region_id: 2 }),
    fig('borrowing', 30, { region_id: 2 }),
    fig('education', 40, { region_id: 2 }),
    fig('health', 15, { region_id: 2 }),
    fig('agriculture', 45, { region_id: 2 }),
    fig('police_justice', 15, { region_id: 2 }),
    fig('interest', 25, { region_id: 2 }),
    fig('transfers_to_local_bodies', 10, { region_id: 2 }),
    fig('administration_other', 50, { region_id: 2 }),
  ];

  test("the share of Union taxes counts as money from the Union, not the state's own taxes", () => {
    const s = summariseFinance(state, { population: null });
    assert.equal(s?.taxes.total, 110);
    assert.equal(s?.spending.total, 200);
    assert.equal(s?.gap.per_rupee.find((p) => p.group === 'from_union')?.amount, 50);
    assert.match(s?.gap.explanation ?? '', /the Union 25p/);
    assert.ok(s?.notes.some((n) => /collected by the Union/.test(n)));
    assert.equal(s?.gap.reconciles, true);
  });
});

describe('finance: year-on-year and provenance', () => {
  test("each line carries last year's figure at last year's most final stage", () => {
    const figures = [
      ...union('BE'),
      ...union('BE', '2024-25', 0.8),
      ...union('actual', '2024-25', 0.9),
    ];
    const s = summariseFinance(figures, { population: null });
    const gst = s?.taxes.items.find((i) => i.category === 'gst');
    assert.deepEqual(gst?.previous, { fy: '2024-25', stage: 'actual', amount: 162 });
  });

  test('sample figures are labelled all the way through', () => {
    const s = summariseFinance(
      union().map((f) => ({ ...f, provenance: 'sample' as const })),
      { population: null },
    );
    assert.deepEqual(s?.provenance, ['sample']);
    assert.ok(s?.notes.some((n) => /SAMPLE/.test(n)));
  });

  test('a year or stage with no figures is null, not an empty summary', () => {
    assert.equal(summariseFinance([], { population: null }), null);
    assert.equal(summariseFinance(union(), { fy: '2019-20', population: null }), null);
    assert.equal(summariseFinance(union(), { stage: 'actual', population: null }), null);
  });
});
