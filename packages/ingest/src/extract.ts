/**
 * Structured facts from the text of government documents.
 *
 * This is where "make it more precise" is actually earned. A GO is not just a title: it has a number
 * that identifies it uniquely, a type that says whether it is policy or routine, a department, a date,
 * sometimes a sanctioned amount; a recruitment notification has a vacancy count and a closing date.
 * Pulling those out is what lets the platform say "₹1,250 crore sanctioned for Hyderabad storm-water
 * drains" rather than show a link.
 */

// ─────────────────────────── GO numbers ───────────────────────────

/**
 * Telangana and Andhra Pradesh number their orders "G.O.Ms.No.45" or "G.O.Rt.No.1234", with a great
 * deal of variation in dots, spaces and case. The type matters:
 *
 *  - **Ms.** (manuscript) orders carry policy and significant decisions — they become discussion topics.
 *  - **Rt.** (routine) orders are transfers, sanctions of leave, and the like — indexed and searchable,
 *    but not put in front of citizens as something to have an opinion about.
 */
export interface GoReference {
  type: 'Ms' | 'Rt' | 'P';
  number: number;
  /** The canonical form, "G.O.Ms.No.45", for deduplication and display. */
  canonical: string;
}

const GO_PATTERN = /\bG\s*\.?\s*O\s*\.?\s*(Ms|Rt|P)\s*\.?\s*No\s*\.?\s*:?\s*(\d{1,6})\b/gi;

export function extractGoNumbers(text: string): GoReference[] {
  const out = new Map<string, GoReference>();
  for (const m of text.matchAll(GO_PATTERN)) {
    const raw = (m[1] as string).toLowerCase();
    const type = raw === 'ms' ? 'Ms' : raw === 'rt' ? 'Rt' : 'P';
    const number = Number(m[2]);
    const canonical = `G.O.${type}.No.${number}`;
    out.set(canonical, { type, number, canonical });
  }
  return [...out.values()];
}

/** Central Gazette: "S.O. 1234(E)" (statutory orders) and "G.S.R. 567(E)" (general statutory rules). */
export function extractGazetteNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /\b(S\s*\.?\s*O|G\s*\.?\s*S\s*\.?\s*R)\s*\.?\s*(\d{1,6})\s*\(\s*(E)\s*\)/gi,
  )) {
    const prefix =
      (m[1] as string).replace(/[\s.]/g, '').toUpperCase() === 'SO' ? 'S.O.' : 'G.S.R.';
    out.add(`${prefix} ${m[2]}(E)`);
  }
  return [...out];
}

// ─────────────────────────── Numbers, Indian style ───────────────────────────

/** "1,23,456" and "123,456" are both 123456 — Indian grouping is lakh-based, not thousand-based. */
export function parseIndianNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

const UNITS: Array<[RegExp, number]> = [
  [/^lakh\s*crores?$|^lakh\s*cr\.?$/i, 1e12],
  [/^crores?$|^cr\.?$|^crs\.?$/i, 1e7],
  [/^lakhs?$|^lacs?$|^lac$/i, 1e5],
  [/^thousand$/i, 1e3],
  [/^करोड़$/, 1e7],
  [/^लाख$/, 1e5],
  [/^కోట్లు$|^కోట్ల$/, 1e7],
  [/^లక్షలు$|^లక్షల$/, 1e5],
];

/**
 * Rupee amounts, normalised to rupees: "Rs. 1,250 crore", "₹500 cr", "Rs 45 lakh", "₹1.2 lakh crore",
 * "INR 300 crore", "Rs.12,34,567", "रु. 500 करोड़", "రూ.500 కోట్లు".
 */
export interface Amount {
  rupees: number;
  text: string;
}

const AMOUNT_PATTERN =
  /(?:₹|rs\.?|inr|रु\.?|रुपये|రూ\.?)\s*([\d,]+(?:\.\d+)?)\s*(lakh\s*crores?|lakh\s*cr\.?|crores?|crs?\.?|lakhs?|lacs?|thousand|करोड़|लाख|కోట్లు|కోట్ల|లక్షలు|లక్షల)?/gi;

export function extractAmounts(text: string): Amount[] {
  const out: Amount[] = [];
  for (const m of text.matchAll(AMOUNT_PATTERN)) {
    const value = parseIndianNumber(m[1] as string);
    if (value === null || value === 0) continue;
    const unitText = (m[2] ?? '').trim();
    const multiplier = unitText ? (UNITS.find(([re]) => re.test(unitText))?.[1] ?? 1) : 1;
    out.push({ rupees: Math.round(value * multiplier), text: m[0].trim() });
  }
  return out;
}

// ─────────────────────────── Vacancies ───────────────────────────

/**
 * Vacancy counts from recruitment notifications: "1,234 posts", "Total Vacancies: 450", "No. of
 * Posts: 12", "(1,500 Posts)", "4500 पद", "450 ఖాళీలు", "450 పోస్టులు". This is what answers "how
 * many government jobs are open".
 *
 * Returns the largest figure found — a notification that lists "Total: 1,234" and then category-wise
 * rows of 300, 250… means 1,234, not the sum of every number on the page.
 */
export function extractVacancies(text: string): number | null {
  const patterns = [
    /(?:total\s+)?(?:no\.?\s+of\s+)?(?:vacanc(?:y|ies)|posts?)\s*[:\-–]\s*([\d,]+)/gi,
    // "Total Vacancies 85": the separator is optional only after "total" — a bare "posts 3" is too
    // often "3 years of experience".
    /total\s+(?:no\.?\s+of\s+)?(?:vacanc(?:y|ies)|posts?)\s+([\d,]+)/gi,
    /([\d,]+)\s*(?:vacanc(?:y|ies)|posts?|positions?)\b/gi,
    /([\d,]+)\s*(?:पदों|पद|रिक्तियों|रिक्तियां)/g,
    /([\d,]+)\s*(?:ఖాళీలు|పోస్టులు|పోస్టుల)/g,
  ];
  let best: number | null = null;
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const n = parseIndianNumber(m[1] as string);
      // Years ("2026 posts" is not a thing) and absurd values are not vacancy counts.
      if (
        n === null ||
        n <= 0 ||
        n > 500_000 ||
        (n >= 1990 && n <= 2100 && !/,/.test(m[1] as string))
      )
        continue;
      if (best === null || n > best) best = n;
    }
  }
  return best;
}

// ─────────────────────────── Dates ───────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1950 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // 31.02 is not a date
  return date.toISOString().slice(0, 10);
}

/**
 * Dates as Indian documents write them. Numeric dates are **day-first** (12.03.2026 is 12 March):
 * reading them month-first, as a US-default parser would, silently corrupts every date after the 12th
 * of the month and swaps day and month before it.
 */
export function parseIndianDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/.exec(s);
  if (m) {
    const year = (m[3] as string).length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(year, Number(m[2]), Number(m[1]));
  }

  m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);
  if (m) {
    const month = MONTHS[(m[2] as string).toLowerCase()];
    if (month) return iso(Number(m[3]), month, Number(m[1]));
  }

  m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (m) {
    const month = MONTHS[(m[1] as string).toLowerCase()];
    if (month) return iso(Number(m[3]), month, Number(m[2]));
  }

  // RFC 822 dates from RSS feeds.
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** The closing date of an application window: "Last date: 15-10-2026", "closing date is 15.10.2026". */
export function extractClosingDate(text: string): string | null {
  const m =
    /(?:last\s+date|closing\s+date|apply(?:\s+online)?\s+(?:by|before|on\s+or\s+before)|on\s+or\s+before|till|अंतिम\s+तिथि|చివరి\s+తేదీ)[^\d]{0,40}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4})/i.exec(
      text,
    );
  return m ? parseIndianDate(m[1] as string) : null;
}

/** Departments as the Telangana/AP secretariat abbreviates them, expanded for display and search. */
export const DEPARTMENTS: Record<string, string> = {
  'MA&UD': 'Municipal Administration & Urban Development',
  'PR&RD': 'Panchayat Raj & Rural Development',
  'I&CAD': 'Irrigation & Command Area Development',
  'HM&FW': 'Health, Medical & Family Welfare',
  'TR&B': 'Transport, Roads & Buildings',
  GAD: 'General Administration',
  AGRI: 'Agriculture & Co-operation',
  FIN: 'Finance',
  EDN: 'Education',
  HOME: 'Home',
  REV: 'Revenue',
  ENERGY: 'Energy',
  'LET&F': 'Labour, Employment, Training & Factories',
  'WCD&SC': 'Women, Children, Disabled & Senior Citizens',
};

export function extractDepartment(text: string): string | null {
  for (const [abbr, name] of Object.entries(DEPARTMENTS)) {
    const escaped = abbr.replace(/[&]/g, '\\s*&\\s*');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return name;
    if (text.toLowerCase().includes(name.toLowerCase())) return name;
  }
  return null;
}
