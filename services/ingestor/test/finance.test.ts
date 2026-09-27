import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { summariseFinance } from '@civic-voice/core';
import {
  createMemoryRepositories,
  seedMemoryGeography,
  type MemoryRepositories,
} from '@civic-voice/db';
import { financeFileSchema, loadFinance, SAMPLE_FINANCE } from '../src/finance.ts';

describe('finance loader', () => {
  let repos: MemoryRepositories;
  let ids: Map<string, number>;

  beforeEach(() => {
    repos = createMemoryRepositories();
    ids = seedMemoryGeography(repos.catalogue);
  });

  test('the sample validates, loads, reconciles, and is marked sample throughout', async () => {
    const file = financeFileSchema.parse(SAMPLE_FINANCE);
    const r = await loadFinance(repos, file);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.warnings, [], 'every sample budget balances');
    const union = await repos.catalogue.fiscalLines(ids.get('IN') as number);
    assert.ok(union.length > 40);
    assert.ok(union.every((l) => l.provenance === 'sample'));
  });

  test('every sample budget balances exactly, so the gap is explained to the rupee', () => {
    for (const b of SAMPLE_FINANCE.budgets) {
      const s = summariseFinance(
        b.lines.map((l) => ({
          region_id: 1,
          fy: b.fy,
          stage: b.stage,
          category: l.category,
          amount: l.amount_crore,
          source_name: b.source_name,
          source_url: b.source_url,
          provenance: 'sample' as const,
        })),
        { population: null },
      );
      assert.equal(s?.gap.residual, 0, `${b.region} ${b.fy} ${b.stage}`);
    }
  });

  test('the Union collects the taxes the overview names; a state its own', () => {
    const categories = (region: string) =>
      new Set(
        SAMPLE_FINANCE.budgets
          .filter((b) => b.region === region)
          .flatMap((b) => b.lines.map((l) => l.category)),
      );
    for (const c of ['income_tax', 'corporate_tax', 'gst', 'customs', 'excise'] as const)
      assert.ok(categories('IN').has(c), c);
    assert.ok(!categories('IN-TG').has('income_tax'), 'a state does not levy income tax');
    assert.ok(categories('IN-TG').has('tax_devolution_received'));
  });

  test('a category twice in one budget is refused, not silently summed', () => {
    const parsed = financeFileSchema.safeParse({
      budgets: [
        {
          region: 'IN',
          fy: '2025-26',
          stage: 'BE',
          source_name: 'Budget at a Glance',
          source_url: 'https://www.indiabudget.gov.in/',
          lines: [
            { category: 'gst', amount_crore: 1 },
            { category: 'gst', amount_crore: 2 },
          ],
        },
      ],
    });
    assert.equal(parsed.success, false);
    assert.match(JSON.stringify(parsed.error?.issues), /appears twice/);
  });

  test('an unknown category or stage is refused', () => {
    const base = {
      region: 'IN',
      fy: '2025-26',
      source_name: 'Budget at a Glance',
      source_url: 'https://www.indiabudget.gov.in/',
    };
    assert.equal(
      financeFileSchema.safeParse({
        budgets: [{ ...base, stage: 'BE', lines: [{ category: 'lottery', amount_crore: 1 }] }],
      }).success,
      false,
    );
    assert.equal(
      financeFileSchema.safeParse({
        budgets: [
          { ...base, stage: 'vote_on_account', lines: [{ category: 'gst', amount_crore: 1 }] },
        ],
      }).success,
      false,
    );
  });

  test('a budget that does not reconcile loads, with a warning that says why', async () => {
    const r = await loadFinance(
      repos,
      financeFileSchema.parse({
        budgets: [
          {
            region: 'IN-TG',
            fy: '2023-24',
            stage: 'actual',
            source_name: 'Finance Accounts',
            source_url: 'https://cag.gov.in/',
            lines: [
              { category: 'gst', amount_crore: 50 },
              { category: 'education', amount_crore: 100 },
            ],
          },
          {
            region: 'IN-XX',
            fy: '2023-24',
            stage: 'actual',
            source_name: 'Finance Accounts',
            source_url: 'https://cag.gov.in/',
            lines: [{ category: 'gst', amount_crore: 1 }],
          },
        ],
      }),
    );
    assert.equal(r.loaded, 2);
    assert.deepEqual(r.skipped, [
      { region: 'IN-XX', fy: '2023-24', reason: 'no such region in the catalogue' },
    ]);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]?.message ?? '', /no borrowing figure/);
  });
});
