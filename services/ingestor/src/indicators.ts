import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { INDICATOR_CATEGORIES, PROVENANCE_KINDS } from '@civic-voice/contracts';
import type { IndicatorRow, Repositories } from '@civic-voice/db';

/**
 * Socio-economic indicators: how much money there is (budgets, deficits, debt), what things cost,
 * how many people are out of work, what crops fetch.
 *
 * These are published by MoSPI, the RBI, the Union and state finance departments and the CACP —
 * mostly as PDFs and spreadsheets on their own schedules, not as feeds. So this is a *loader*, not a
 * scraper: a reviewed JSON file of published figures, each with the source it came from, validated
 * and upserted. Nothing reaches the catalogue without a source URL.
 */
export const indicatorFileSchema = z.object({
  indicators: z.array(
    z.object({
      code: z.string().regex(/^[a-z0-9_]+$/),
      name: z.string().min(3),
      category: z.enum(INDICATOR_CATEGORIES),
      unit: z.string().min(1),
      source_name: z.string().min(3),
      source_url: z.string().url(),
      note: z.string().nullable().default(null),
      observations: z.array(
        z.object({
          /** Region key from @civic-voice/geo ("IN", "IN-TG"). */
          region: z.string(),
          /** As published: "2025-26" (financial year), "2026-08" (month), "2025" (year), "Q1 2026". */
          period: z.string(),
          value: z.number().finite(),
          provenance: z.enum(PROVENANCE_KINDS).default('official'),
        }),
      ),
    }),
  ),
});
export type IndicatorFile = z.infer<typeof indicatorFileSchema>;

/** A sortable start date for a published period label. Financial years start in April. */
export function periodStart(period: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})$/.exec(period))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    // "2025-26" is a financial year; "2026-08" is a month.
    if (b === (a + 1) % 100) return `${a}-04-01`;
    if (b >= 1 && b <= 12) return `${a}-${m[2]}-01`;
  }
  if ((m = /^(\d{4})$/.exec(period))) return `${m[1]}-01-01`;
  if ((m = /^Q([1-4]) (\d{4})$/.exec(period)))
    return `${m[2]}-${String((Number(m[1]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  throw new RangeError(`unrecognised period "${period}"; use 2025-26, 2026-08, 2025 or Q1 2026`);
}

export async function loadIndicators(
  repos: Repositories,
  file: IndicatorFile,
): Promise<{ loaded: number; skipped: Array<{ code: string; region: string; reason: string }> }> {
  const rows: IndicatorRow[] = [];
  const skipped: Array<{ code: string; region: string; reason: string }> = [];
  for (const ind of file.indicators) {
    for (const obs of ind.observations) {
      const region = await repos.catalogue.regionByKey(obs.region);
      if (!region) {
        skipped.push({
          code: ind.code,
          region: obs.region,
          reason: 'no such region in the catalogue',
        });
        continue;
      }
      rows.push({
        code: ind.code,
        name: ind.name,
        category: ind.category,
        unit: ind.unit,
        source_name: ind.source_name,
        source_url: ind.source_url,
        note: ind.note,
        region_id: region.id,
        period: obs.period,
        period_start: periodStart(obs.period),
        value: obs.value,
        provenance: obs.provenance,
      });
    }
  }
  await repos.documents.upsertIndicators(rows);
  return { loaded: rows.length, skipped };
}

export async function readIndicatorFile(path: string): Promise<IndicatorFile> {
  return indicatorFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

const SAMPLE_NOTE =
  'SAMPLE — development seed value of roughly the right magnitude. Not an official figure; load the published one.';

/**
 * Development seed: the indicator catalogue with real sources and SAMPLE values, every one marked
 * `sample` so the UI badges it. Replace with published figures via `pnpm indicators:load <file>`.
 */
export const SAMPLE_INDICATORS: IndicatorFile = {
  indicators: [
    {
      code: 'budget_total_expenditure',
      name: 'Budget: total expenditure',
      category: 'public_finance',
      unit: '₹ crore',
      source_name: 'Union Budget / state budget documents',
      source_url: 'https://www.indiabudget.gov.in/',
      note: SAMPLE_NOTE,
      observations: [
        { region: 'IN', period: '2025-26', value: 5_065_000, provenance: 'sample' },
        { region: 'IN', period: '2026-27', value: 5_400_000, provenance: 'sample' },
        { region: 'IN-TG', period: '2025-26', value: 304_000, provenance: 'sample' },
        { region: 'IN-TG', period: '2026-27', value: 320_000, provenance: 'sample' },
        { region: 'IN-AP', period: '2026-27', value: 330_000, provenance: 'sample' },
      ],
    },
    {
      code: 'fiscal_deficit_pct',
      name: 'Fiscal deficit (% of GDP / GSDP)',
      category: 'public_finance',
      unit: '%',
      source_name: 'Union Budget; RBI, State Finances: A Study of Budgets',
      source_url:
        'https://www.rbi.org.in/Scripts/AnnualPublications.aspx?head=State+Finances+%3a+A+Study+of+Budgets',
      note: SAMPLE_NOTE,
      observations: [
        { region: 'IN', period: '2025-26', value: 4.4, provenance: 'sample' },
        { region: 'IN', period: '2026-27', value: 4.2, provenance: 'sample' },
        { region: 'IN-TG', period: '2026-27', value: 3.0, provenance: 'sample' },
      ],
    },
    {
      code: 'outstanding_liabilities_pct',
      name: 'Outstanding liabilities (% of GSDP)',
      category: 'public_finance',
      unit: '%',
      source_name: 'RBI, State Finances: A Study of Budgets',
      source_url:
        'https://www.rbi.org.in/Scripts/AnnualPublications.aspx?head=State+Finances+%3a+A+Study+of+Budgets',
      note: SAMPLE_NOTE,
      observations: [
        { region: 'IN-TG', period: '2025-26', value: 27.0, provenance: 'sample' },
        { region: 'IN-AP', period: '2025-26', value: 34.0, provenance: 'sample' },
      ],
    },
    {
      code: 'cpi_inflation',
      name: 'Retail inflation (CPI, year on year)',
      category: 'economy',
      unit: '%',
      source_name: 'MoSPI, Consumer Price Index',
      source_url: 'https://www.mospi.gov.in/',
      note: SAMPLE_NOTE,
      observations: [
        { region: 'IN', period: '2026-07', value: 3.4, provenance: 'sample' },
        { region: 'IN', period: '2026-08', value: 3.1, provenance: 'sample' },
      ],
    },
    {
      code: 'unemployment_rate',
      name: 'Unemployment rate (15+, current weekly status)',
      category: 'jobs',
      unit: '%',
      source_name: 'MoSPI, Periodic Labour Force Survey',
      source_url: 'https://www.mospi.gov.in/',
      note: SAMPLE_NOTE,
      observations: [
        { region: 'IN', period: '2026-07', value: 5.2, provenance: 'sample' },
        { region: 'IN', period: '2026-08', value: 5.1, provenance: 'sample' },
      ],
    },
    {
      code: 'youth_unemployment_rate',
      name: 'Youth unemployment rate (15–29, urban, CWS)',
      category: 'jobs',
      unit: '%',
      source_name: 'MoSPI, Periodic Labour Force Survey',
      source_url: 'https://www.mospi.gov.in/',
      note: SAMPLE_NOTE,
      observations: [
        { region: 'IN', period: 'Q1 2026', value: 16.5, provenance: 'sample' },
        { region: 'IN', period: 'Q2 2026', value: 15.9, provenance: 'sample' },
        { region: 'IN-TG', period: 'Q2 2026', value: 17.2, provenance: 'sample' },
      ],
    },
    {
      code: 'msp_paddy_common',
      name: 'Minimum support price: paddy (common)',
      category: 'agriculture',
      unit: '₹ per quintal',
      source_name: 'CACP / Cabinet Committee on Economic Affairs (via PIB)',
      source_url: 'https://cacp.da.gov.in/',
      note: SAMPLE_NOTE,
      observations: [
        { region: 'IN', period: '2025-26', value: 2_369, provenance: 'sample' },
        { region: 'IN', period: '2026-27', value: 2_450, provenance: 'sample' },
      ],
    },
  ],
};
