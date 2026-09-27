/**
 * Public finances: what a government collects in taxes, by category; what it spends, by sector; and
 * the gap between the two — how much of every rupee spent the taxes actually paid for, and what
 * covered the rest.
 *
 * Figures are the ones governments publish in their budget documents (Budget at a Glance, Receipt and
 * Expenditure Budgets, state Annual Financial Statements), in ₹ crore, at one of three stages. Nothing
 * is computed from them that the documents would not support: shares, per-rupee splits, and the
 * difference between receipts and spending, with any figure that does not reconcile shown as such.
 */
import { z } from 'zod';
import { PROVENANCE_KINDS, type Need } from './enums.ts';
import { regionId } from './schemas.ts';

/**
 * Budget estimate (presented with the budget), revised estimate (a year later), actual (audited
 * accounts, two years later). The same year's numbers differ between stages, sometimes a lot, so a
 * figure is never shown without its stage.
 */
export const FISCAL_STAGES = ['BE', 'RE', 'actual'] as const;
export type FiscalStage = (typeof FISCAL_STAGES)[number];
export const FISCAL_STAGE_LABELS: Record<FiscalStage, string> = {
  BE: 'Budget estimate',
  RE: 'Revised estimate',
  actual: 'Actual (audited)',
};

/**
 * Taxes a government collects itself. The Union levies the first five; states levy the rest, plus
 * their half of GST. "Excise" is Union excise on fuel for the Union and state excise on liquor for a
 * state — the budget documents use the one word for both.
 */
export const TAX_CATEGORIES = [
  'income_tax',
  'corporate_tax',
  'gst',
  'customs',
  'excise',
  'stamp_registration',
  'sales_tax_vat',
  'vehicle_tax',
  'other_tax',
] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

/** Everything else that pays for spending: what the government earns, receives, and borrows. */
export const OTHER_RECEIPT_CATEGORIES = [
  'non_tax_revenue',
  'non_debt_capital',
  'tax_devolution_received',
  'grants_received',
  'borrowing',
] as const;
export type OtherReceiptCategory = (typeof OTHER_RECEIPT_CATEGORIES)[number];

/**
 * Where the money goes. The first twelve are programmes a citizen can have a view on; the last four
 * are committed or pass-through — interest on past borrowing, pensions, money handed to another
 * government to spend — and are shown, because they are most of the gap, but no topic is "about" them.
 */
export const SPENDING_SECTORS = [
  'infrastructure',
  'housing_urban',
  'health',
  'education',
  'defence',
  'rural_development',
  'agriculture',
  'water_sanitation',
  'subsidies_welfare',
  'labour_employment',
  'police_justice',
  'administration_other',
  'interest',
  'pensions',
  'transfers_to_states',
  'transfers_to_local_bodies',
] as const;
export type SpendingSector = (typeof SPENDING_SECTORS)[number];

export const COMMITTED_SECTORS: readonly SpendingSector[] = [
  'interest',
  'pensions',
  'transfers_to_states',
  'transfers_to_local_bodies',
];

/** The sectors a topic can be about: programmes, not committed or pass-through spending. */
export const PROGRAMME_SECTORS = SPENDING_SECTORS.filter(
  (s) => !COMMITTED_SECTORS.includes(s),
) as Exclude<
  SpendingSector,
  'interest' | 'pensions' | 'transfers_to_states' | 'transfers_to_local_bodies'
>[];
export type ProgrammeSector = (typeof PROGRAMME_SECTORS)[number];

export const FISCAL_CATEGORIES = [
  ...TAX_CATEGORIES,
  ...OTHER_RECEIPT_CATEGORIES,
  ...SPENDING_SECTORS,
] as const;
export type FiscalCategory = (typeof FISCAL_CATEGORIES)[number];

export const FISCAL_LABELS: Record<FiscalCategory, string> = {
  income_tax: 'Income tax',
  corporate_tax: 'Corporation tax',
  gst: 'GST',
  customs: 'Customs duty',
  excise: 'Excise duty',
  stamp_registration: 'Stamps & registration',
  sales_tax_vat: 'Sales tax / VAT (fuel, liquor)',
  vehicle_tax: 'Vehicle tax',
  other_tax: 'Other taxes & levies',
  non_tax_revenue: 'Non-tax revenue (dividends, fees, royalties)',
  non_debt_capital: 'Disinvestment & loan recoveries',
  tax_devolution_received: 'Share of Union taxes',
  grants_received: 'Grants from the Union',
  borrowing: 'Borrowing',
  infrastructure: 'Infrastructure (roads, rail, power)',
  housing_urban: 'Housing & urban development',
  health: 'Health',
  education: 'Education',
  defence: 'Defence',
  rural_development: 'Rural development',
  agriculture: 'Agriculture & allied',
  water_sanitation: 'Water & sanitation',
  subsidies_welfare: 'Subsidies & welfare',
  labour_employment: 'Jobs & skills',
  police_justice: 'Police & justice',
  administration_other: 'Administration & other',
  interest: 'Interest on past borrowing',
  pensions: 'Pensions',
  transfers_to_states: 'Passed to states (tax share & grants)',
  transfers_to_local_bodies: 'Passed to local bodies',
};

export function isTaxCategory(c: FiscalCategory): c is TaxCategory {
  return (TAX_CATEGORIES as readonly string[]).includes(c);
}
export function isSpendingSector(c: FiscalCategory): c is SpendingSector {
  return (SPENDING_SECTORS as readonly string[]).includes(c);
}

/**
 * Which spending head answers each need people raise. `null` where no head does — corruption is not
 * a budget line — and the insight says so rather than forcing a match. A `Record` over every need, so
 * a new need fails to compile until someone places it. Prices map to subsidies because
 * food and fuel subsidies are the budget's answer to prices; the mapping is published with the result.
 */
export const NEED_SECTOR: Record<Need, ProgrammeSector | null> = {
  employment: 'labour_employment',
  education: 'education',
  health: 'health',
  agriculture: 'agriculture',
  water: 'water_sanitation',
  roads_transport: 'infrastructure',
  housing: 'housing_urban',
  electricity: 'infrastructure',
  sanitation: 'water_sanitation',
  safety: 'police_justice',
  corruption: null,
  prices: 'subsidies_welfare',
  welfare: 'subsidies_welfare',
  environment: null,
};

const amount = z.number().nonnegative();
const share = z.number().min(0).max(1);

export const financeLineSchema = z.object({
  category: z.enum(FISCAL_CATEGORIES),
  label: z.string(),
  /** ₹ crore. */
  amount,
  /** Of total taxes (for a tax) or of total spending (for a sector). */
  share,
  /** The same category in the previous year, at that year's best available stage. */
  previous: z.object({ fy: z.string(), stage: z.enum(FISCAL_STAGES), amount }).nullable(),
  committed: z.boolean(),
  source_url: z.string().url(),
});
export type FinanceLine = z.infer<typeof financeLineSchema>;

/** Where each rupee spent came from, in groups a citizen recognises. */
export const RECEIPT_GROUPS = [
  'taxes',
  'other_own',
  'from_union',
  'borrowing',
  'unexplained',
] as const;
export type ReceiptGroup = (typeof RECEIPT_GROUPS)[number];

export const financeSummarySchema = z.object({
  fy: z.string(),
  stage: z.enum(FISCAL_STAGES),
  stage_label: z.string(),
  /** Every amount in this summary is in ₹ crore (1 crore = 10 million). */
  unit: z.literal('₹ crore'),
  taxes: z.object({
    total: amount,
    /** ₹ per resident, when the region's population is known. */
    per_capita: z.number().nullable(),
    items: z.array(financeLineSchema),
  }),
  spending: z.object({
    total: amount,
    per_capita: z.number().nullable(),
    items: z.array(financeLineSchema),
  }),
  /** Spending minus taxes, and what covered it. Positive when spending exceeded the taxes collected. */
  gap: z.object({
    amount: z.number(),
    /** Taxes ÷ spending: the share of each rupee spent that taxes paid for. */
    taxes_cover: z.number().min(0),
    /** Each group's share of a rupee spent. Sums to 1 when receipts reconcile with spending. */
    per_rupee: z.array(
      z.object({ group: z.enum(RECEIPT_GROUPS), label: z.string(), amount, share: z.number() }),
    ),
    /**
     * Receipts minus spending, when a borrowing figure is published. Budget documents carry
     * adjustments (cash balance draw-downs, public account) that are not in these lines; a residual
     * beyond 2% of spending is flagged rather than folded quietly into a bigger number.
     */
    residual: z.number().nullable(),
    reconciles: z.boolean(),
    explanation: z.string(),
  }),
  sources: z.array(z.object({ name: z.string(), url: z.string().url() })),
  provenance: z.array(z.enum(PROVENANCE_KINDS)),
  notes: z.array(z.string()),
});
export type FinanceSummary = z.infer<typeof financeSummarySchema>;

export const financeResponseSchema = z.object({
  region_id: regionId,
  region_name: z.string(),
  population: z.number().nullable(),
  /** Years and stages this government has figures for, newest first. */
  available: z.array(z.object({ fy: z.string(), stages: z.array(z.enum(FISCAL_STAGES)) })),
  /** Null when there are no figures for this government (or for the year asked). */
  summary: financeSummarySchema.nullable(),
});
export type FinanceResponse = z.infer<typeof financeResponseSchema>;
