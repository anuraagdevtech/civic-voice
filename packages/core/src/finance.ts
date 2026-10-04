import {
  COMMITTED_SECTORS,
  FISCAL_LABELS,
  FISCAL_STAGE_LABELS,
  FISCAL_STAGES,
  isSpendingSector,
  isTaxCategory,
  type FinanceLine,
  type FinanceSummary,
  type FiscalCategory,
  type FiscalStage,
  type ProvenanceKind,
  type ReceiptGroup,
} from '@civic-voice/contracts';

/**
 * Taxes collected, spending by sector, and the gap between them — computed from the figures a
 * government publishes, and nothing else.
 *
 * The one piece of judgement here is how to show the gap honestly. Spending is always more than taxes
 * (for the Union, by about a third), and the difference is covered by other receipts and by borrowing.
 * So the gap is shown as the budget documents themselves show it — where each rupee spent came from —
 * and when the published lines do not add up, the shortfall is shown as a shortfall, not quietly
 * assigned to borrowing.
 */

/** One published figure: a category of receipt or spending, for one government, year and stage. */
export interface FiscalFigure {
  region_id: number;
  fy: string;
  stage: FiscalStage;
  category: FiscalCategory;
  /** ₹ crore. */
  amount: number;
  source_name: string;
  source_url: string;
  provenance: ProvenanceKind;
}

/** Receipts and spending may differ by this share of spending before the summary says they do not reconcile. */
export const RECONCILIATION_TOLERANCE = 0.02;

const GROUP_OF: Partial<Record<FiscalCategory, ReceiptGroup>> = {
  non_tax_revenue: 'other_own',
  non_debt_capital: 'other_own',
  tax_devolution_received: 'from_union',
  grants_received: 'from_union',
  borrowing: 'borrowing',
};

/** The same groups, as they read inside a sentence ("came from: borrowing 24p, the Union 17p"). */
const GROUP_PHRASES: Record<ReceiptGroup, string> = {
  taxes: 'taxes',
  other_own: 'other own receipts',
  from_union: 'the Union',
  borrowing: 'borrowing',
  unexplained: 'receipts not in the published figures',
};

const GROUP_LABELS: Record<ReceiptGroup, string> = {
  taxes: 'Taxes collected',
  other_own: 'Other own receipts',
  from_union: 'From the Union',
  borrowing: 'Borrowing',
  unexplained: 'Not covered by the published receipts',
};

/** "2025-26" → "2024-25". */
export function previousFy(fy: string): string {
  const start = Number(fy.slice(0, 4)) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Years with figures, newest first, and the stages each has, in publication order. */
export function availableYears(
  figures: readonly FiscalFigure[],
): Array<{ fy: string; stages: FiscalStage[] }> {
  const byYear = new Map<string, Set<FiscalStage>>();
  for (const f of figures) byYear.set(f.fy, (byYear.get(f.fy) ?? new Set()).add(f.stage));
  return [...byYear.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([fy, stages]) => ({ fy, stages: FISCAL_STAGES.filter((s) => stages.has(s)) }));
}

/** The most final figures a year has: audited actuals, else the revised estimate, else the budget. */
export function bestStage(figures: readonly FiscalFigure[], fy: string): FiscalStage | null {
  for (const stage of [...FISCAL_STAGES].reverse())
    if (figures.some((f) => f.fy === fy && f.stage === stage)) return stage;
  return null;
}

const sum = (xs: readonly FiscalFigure[]) => xs.reduce((t, f) => t + f.amount, 0);

function perCapita(totalCrore: number, population: number | null): number | null {
  return population && population > 0 ? Math.round((totalCrore * 1e7) / population) : null;
}

const paise = (share: number) => `${Math.round(share * 100)}p`;

export function summariseFinance(
  figures: readonly FiscalFigure[],
  opts: { fy?: string; stage?: FiscalStage; population: number | null },
): FinanceSummary | null {
  const fy = opts.fy ?? availableYears(figures)[0]?.fy;
  if (!fy) return null;
  const stage = opts.stage ?? bestStage(figures, fy);
  if (!stage) return null;
  const current = figures.filter((f) => f.fy === fy && f.stage === stage);
  if (current.length === 0) return null;

  const prevFy = previousFy(fy);
  const prevStage = bestStage(figures, prevFy);
  const previous = new Map(
    figures
      .filter((f) => f.fy === prevFy && f.stage === prevStage)
      .map((f) => [f.category, f] as const),
  );

  const lines = (subset: FiscalFigure[], total: number): FinanceLine[] =>
    subset
      .map((f) => {
        const prev = previous.get(f.category);
        return {
          category: f.category,
          label: FISCAL_LABELS[f.category],
          amount: f.amount,
          share: total > 0 ? f.amount / total : 0,
          previous:
            prev && prevStage ? { fy: prevFy, stage: prevStage, amount: prev.amount } : null,
          committed: (COMMITTED_SECTORS as readonly string[]).includes(f.category),
          source_url: f.source_url,
        };
      })
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));

  const taxes = current.filter((f) => isTaxCategory(f.category));
  const spending = current.filter((f) => isSpendingSector(f.category));
  const taxTotal = sum(taxes);
  const spendTotal = sum(spending);

  const groups = new Map<ReceiptGroup, number>([['taxes', taxTotal]]);
  for (const f of current) {
    const g = GROUP_OF[f.category];
    if (g) groups.set(g, (groups.get(g) ?? 0) + f.amount);
  }
  const receiptsTotal = [...groups.values()].reduce((a, b) => a + b, 0);
  const borrowingPublished = current.some((f) => f.category === 'borrowing');

  const notes: string[] = [];
  let residual: number | null = null;
  let reconciles = false;
  if (borrowingPublished) {
    residual = receiptsTotal - spendTotal;
    reconciles = spendTotal > 0 && Math.abs(residual) <= RECONCILIATION_TOLERANCE * spendTotal;
    if (!reconciles && spendTotal > 0)
      notes.push(
        `Receipts and spending differ by ₹${Math.abs(Math.round(residual)).toLocaleString('en-IN')} crore ` +
          `(${((Math.abs(residual) / spendTotal) * 100).toFixed(1)}% of spending): adjustments these lines do not ` +
          'carry, such as drawing down cash balances or the public account. Shown, not absorbed.',
      );
  }
  if (receiptsTotal < spendTotal && (!borrowingPublished || !reconciles))
    groups.set('unexplained', spendTotal - receiptsTotal);

  const per_rupee = [...groups.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([group, amount]) => ({
      group,
      label:
        group === 'unexplained' && !borrowingPublished
          ? 'Not covered by the published receipts (borrowing not published)'
          : GROUP_LABELS[group],
      amount,
      share: spendTotal > 0 ? amount / spendTotal : 0,
    }))
    .sort((a, b) => (a.group === 'taxes' ? -1 : b.group === 'taxes' ? 1 : b.amount - a.amount));

  const taxesCover = spendTotal > 0 ? taxTotal / spendTotal : 0;
  const stageLabel = FISCAL_STAGE_LABELS[stage];
  let explanation: string;
  if (spendTotal === 0) {
    explanation = `No spending figures are published for ${fy} (${stageLabel.toLowerCase()}).`;
  } else if (taxTotal >= spendTotal) {
    explanation = `In ${fy} (${stageLabel.toLowerCase()}), taxes collected exceeded spending by ₹${Math.round(taxTotal - spendTotal).toLocaleString('en-IN')} crore.`;
  } else {
    const rest = per_rupee
      .filter((p) => p.group !== 'taxes')
      .map((p) => `${GROUP_PHRASES[p.group]} ${paise(p.share)}`);
    explanation =
      `In ${fy} (${stageLabel.toLowerCase()}), taxes collected paid for ${paise(taxesCover)} of every rupee spent. ` +
      `The other ${paise(1 - taxesCover)} came from: ${rest.join(', ')}.`;
  }

  if (current.some((f) => f.category === 'transfers_to_states'))
    notes.push(
      "Taxes are gross: they include the states' share, which the Union passes on and which appears under spending as “Passed to states”.",
    );
  if (current.some((f) => f.category === 'tax_devolution_received'))
    notes.push(
      "The state's share of Union taxes is paid by its residents too, but collected by the Union — so it is shown as money from the Union, not as the state's own taxes.",
    );
  const provenance = [...new Set(current.map((f) => f.provenance))];
  if (provenance.includes('sample'))
    notes.push(
      'Includes SAMPLE figures: development values of roughly the right magnitude, not official statistics.',
    );

  const sources = new Map<string, string>();
  for (const f of current) if (!sources.has(f.source_url)) sources.set(f.source_url, f.source_name);

  return {
    fy,
    stage,
    stage_label: stageLabel,
    unit: '₹ crore',
    taxes: {
      total: taxTotal,
      per_capita: perCapita(taxTotal, opts.population),
      items: lines(taxes, taxTotal),
    },
    spending: {
      total: spendTotal,
      per_capita: perCapita(spendTotal, opts.population),
      items: lines(spending, spendTotal),
    },
    gap: {
      amount: spendTotal - taxTotal,
      taxes_cover: taxesCover,
      per_rupee,
      residual,
      reconciles,
      explanation,
    },
    sources: [...sources.entries()].map(([url, name]) => ({ name, url })),
    provenance,
    notes,
  };
}
