import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  FISCAL_CATEGORIES,
  FISCAL_STAGES,
  PROVENANCE_KINDS,
  type FiscalCategory,
} from '@civic-voice/contracts';
import { summariseFinance } from '@civic-voice/core';
import type { FiscalLineRow, Repositories } from '@civic-voice/db';

/**
 * Public finances: taxes collected by category, other receipts, and spending by sector.
 *
 * The Union publishes these in Budget at a Glance and the Receipt and Expenditure Budgets; each state
 * in its Annual Financial Statement; the RBI collates the states in *State Finances: A Study of
 * Budgets*. All of them are PDFs and spreadsheets, once or twice a year. So, like the indicators, this
 * is a *loader* for a reviewed file rather than a scraper: one entry per government, year and stage,
 * every line mapped by a person to a category the product knows how to label, and a source for each.
 *
 * On load, each budget is summarised and its receipts reconciled against its spending. A budget that
 * does not reconcile is still loaded — published figures carry adjustments — but the loader says so,
 * and the product shows the difference rather than hiding it.
 */
const budgetSchema = z
  .object({
    /** Region key from @civic-voice/geo: "IN" for the Union, "IN-TG" for Telangana. */
    region: z.string(),
    fy: z.string().regex(/^\d{4}-\d{2}$/, 'a financial year such as 2025-26'),
    stage: z.enum(FISCAL_STAGES),
    source_name: z.string().min(3),
    source_url: z.string().url(),
    provenance: z.enum(PROVENANCE_KINDS).default('official'),
    lines: z
      .array(
        z.object({
          category: z.enum(FISCAL_CATEGORIES),
          amount_crore: z.number().finite().nonnegative(),
          /** A more specific document for this line, when there is one. */
          source_url: z.string().url().optional(),
        }),
      )
      .min(1),
  })
  .superRefine((b, ctx) => {
    const seen = new Set<FiscalCategory>();
    for (const l of b.lines) {
      if (seen.has(l.category))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${b.region} ${b.fy} ${b.stage}: "${l.category}" appears twice; add the amounts in the file, where a reviewer can see it`,
        });
      seen.add(l.category);
    }
  });

export const financeFileSchema = z.object({ budgets: z.array(budgetSchema) });
export type FinanceFile = z.infer<typeof financeFileSchema>;

export interface FinanceLoadResult {
  loaded: number;
  skipped: Array<{ region: string; fy: string; reason: string }>;
  /** Budgets whose receipts and spending do not reconcile, with the summary's own explanation. */
  warnings: Array<{ region: string; fy: string; stage: string; message: string }>;
}

export async function loadFinance(
  repos: Repositories,
  file: FinanceFile,
): Promise<FinanceLoadResult> {
  const rows: FiscalLineRow[] = [];
  const result: FinanceLoadResult = { loaded: 0, skipped: [], warnings: [] };
  for (const b of file.budgets) {
    const region = await repos.catalogue.regionByKey(b.region);
    if (!region) {
      result.skipped.push({
        region: b.region,
        fy: b.fy,
        reason: 'no such region in the catalogue',
      });
      continue;
    }
    const budget: FiscalLineRow[] = b.lines.map((l) => ({
      region_id: region.id,
      fy: b.fy,
      stage: b.stage,
      category: l.category,
      amount: l.amount_crore,
      source_name: b.source_name,
      source_url: l.source_url ?? b.source_url,
      provenance: b.provenance,
    }));
    const summary = summariseFinance(budget, { population: null });
    if (summary && !summary.gap.reconciles)
      result.warnings.push({
        region: b.region,
        fy: b.fy,
        stage: b.stage,
        message:
          summary.gap.residual === null
            ? 'no borrowing figure, so receipts cannot be reconciled with spending'
            : (summary.notes[0] ?? 'receipts and spending do not reconcile'),
      });
    rows.push(...budget);
  }
  await repos.catalogue.upsertFiscalLines(rows);
  result.loaded = rows.length;
  return result;
}

export async function readFinanceFile(path: string): Promise<FinanceFile> {
  return financeFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

// ─────────────────────────────── Development sample ───────────────────────────────

const UNION = {
  source_name: 'Union Budget: Budget at a Glance',
  source_url: 'https://www.indiabudget.gov.in/',
  provenance: 'sample' as const,
};
const STATE = {
  source_name: 'RBI, State Finances: A Study of Budgets',
  source_url:
    'https://www.rbi.org.in/Scripts/AnnualPublications.aspx?head=State+Finances+%3a+A+Study+of+Budgets',
  provenance: 'sample' as const,
};

const lines = (amounts: Partial<Record<FiscalCategory, number>>) =>
  Object.entries(amounts).map(([category, amount_crore]) => ({
    category: category as FiscalCategory,
    amount_crore: amount_crore as number,
  }));

/**
 * Development seed: the Union and Telangana, two years each, with SAMPLE amounts of roughly the right
 * magnitude — every one marked `sample`, which the product badges on every figure. Each budget
 * balances, so the sample exercises the reconciled path; the tests exercise the rest. Replace with
 * published figures via `pnpm finance:load <file>`.
 */
export const SAMPLE_FINANCE: FinanceFile = {
  budgets: [
    {
      region: 'IN',
      fy: '2025-26',
      stage: 'BE',
      ...UNION,
      lines: lines({
        income_tax: 1_438_000,
        corporate_tax: 1_082_000,
        gst: 1_178_000,
        customs: 240_000,
        excise: 317_000,
        other_tax: 15_000,
        non_tax_revenue: 583_000,
        non_debt_capital: 76_000,
        borrowing: 1_569_000,
        transfers_to_states: 1_950_000,
        interest: 1_276_000,
        defence: 491_000,
        pensions: 277_000,
        subsidies_welfare: 443_000,
        infrastructure: 652_000,
        housing_urban: 96_800,
        rural_development: 190_000,
        agriculture: 171_000,
        water_sanitation: 99_500,
        health: 99_900,
        education: 128_700,
        labour_employment: 35_000,
        police_justice: 150_000,
        administration_other: 438_100,
      }),
    },
    {
      region: 'IN',
      fy: '2024-25',
      stage: 'RE',
      ...UNION,
      lines: lines({
        income_tax: 1_287_000,
        corporate_tax: 980_000,
        gst: 1_062_000,
        customs: 235_000,
        excise: 305_000,
        other_tax: 13_000,
        non_tax_revenue: 531_000,
        non_debt_capital: 59_000,
        borrowing: 1_570_000,
        transfers_to_states: 1_830_000,
        interest: 1_163_000,
        defence: 471_000,
        pensions: 262_000,
        subsidies_welfare: 440_000,
        infrastructure: 612_000,
        housing_urban: 63_700,
        rural_development: 173_000,
        agriculture: 140_000,
        water_sanitation: 71_000,
        health: 89_000,
        education: 114_000,
        labour_employment: 30_000,
        police_justice: 140_000,
        administration_other: 443_300,
      }),
    },
    {
      region: 'IN-TG',
      fy: '2025-26',
      stage: 'BE',
      ...STATE,
      lines: lines({
        gst: 62_000,
        stamp_registration: 19_000,
        excise: 27_600,
        sales_tax_vat: 37_500,
        vehicle_tax: 8_500,
        other_tax: 4_400,
        tax_devolution_received: 29_900,
        grants_received: 21_800,
        non_tax_revenue: 31_600,
        non_debt_capital: 1_700,
        borrowing: 61_000,
        agriculture: 24_400,
        rural_development: 31_600,
        education: 23_100,
        health: 12_400,
        water_sanitation: 9_000,
        housing_urban: 17_700,
        infrastructure: 22_000,
        subsidies_welfare: 56_000,
        labour_employment: 1_000,
        police_justice: 10_200,
        interest: 24_300,
        pensions: 18_000,
        transfers_to_local_bodies: 8_000,
        administration_other: 47_300,
      }),
    },
    {
      region: 'IN-TG',
      fy: '2024-25',
      stage: 'RE',
      ...STATE,
      lines: lines({
        gst: 55_000,
        stamp_registration: 16_000,
        excise: 25_000,
        sales_tax_vat: 33_000,
        vehicle_tax: 7_500,
        other_tax: 4_000,
        tax_devolution_received: 26_200,
        grants_received: 18_000,
        non_tax_revenue: 28_000,
        non_debt_capital: 1_500,
        borrowing: 57_000,
        agriculture: 22_000,
        rural_development: 28_000,
        education: 21_000,
        health: 11_500,
        water_sanitation: 8_000,
        housing_urban: 15_000,
        infrastructure: 20_000,
        subsidies_welfare: 50_000,
        labour_employment: 900,
        police_justice: 9_500,
        interest: 21_500,
        pensions: 16_500,
        transfers_to_local_bodies: 7_000,
        administration_other: 40_300,
      }),
    },
  ],
};
