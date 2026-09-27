/**
 * PII detection for free-text comments.
 *
 * Public comments are the one place in this system where a citizen can type anything, and in an Indian
 * civic forum the dangerous thing is not profanity — it is someone posting their own (or a neighbour's)
 * phone number, Aadhaar number or PAN in a complaint about a pension or a ration card. docs/PRIVACY.md
 * forbids raw government identifiers anywhere in the system, and that has to include the forum.
 *
 * Detection is tuned for precision on the identifiers that matter most:
 *
 *  - **Aadhaar** numbers are validated with the Verhoeff checksum UIDAI uses, so an arbitrary 12-digit
 *    number (an order number, a phone number with a country code) is not flagged, and a real one is.
 *  - **PAN** is matched on its structure, including the fourth character that encodes the holder type.
 *  - **Indian mobile numbers** must start 6–9 and may carry a +91/0 prefix and spacing.
 */

export type PiiKind = 'aadhaar' | 'pan' | 'phone' | 'email' | 'upi' | 'bank_account';

export interface PiiMatch {
  kind: PiiKind;
  start: number;
  end: number;
}

// ── Verhoeff checksum ──
// The dihedral group D5 multiplication table, the permutation table, and the inverse table.
const D: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** True when the digit string (including its final check digit) satisfies Verhoeff. */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    c = (D[c] as number[])[(P[i % 8] as number[])[Number(reversed[i])] as number] as number;
  }
  return c === 0;
}

/** Compute the check digit for a payload — used by tests to build valid numbers, never to mint IDs. */
export function verhoeffCheckDigit(payload: string): number {
  let c = 0;
  const reversed = payload.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    c = (D[c] as number[])[(P[(i + 1) % 8] as number[])[Number(reversed[i])] as number] as number;
  }
  return INV[c] as number;
}

/** Aadhaar: 12 digits, first digit 2–9, Verhoeff-valid, optionally grouped 4-4-4 by spaces or dashes. */
function isAadhaar(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, '');
  return /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
}

const PATTERNS: Array<{ kind: PiiKind; regex: RegExp; accept?: (m: string) => boolean }> = [
  {
    kind: 'aadhaar',
    regex: /(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
    accept: isAadhaar,
  },
  {
    // Fourth character encodes the holder type: P individual, C company, H HUF, F firm, A AOP,
    // T trust, B BOI, L local authority, J artificial juridical person, G government.
    kind: 'pan',
    regex: /\b[A-Za-z]{3}[PCHFATBLJGpchfatbljg][A-Za-z]\d{4}[A-Za-z]\b/g,
  },
  {
    kind: 'phone',
    regex: /(?<![\d\w])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,
  },
  {
    kind: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    // UPI handles look like emails without a TLD: name@okaxis, 98xxxxxx@ybl.
    kind: 'upi',
    regex:
      /\b[A-Za-z0-9._-]{2,}@(?:ok[a-z]+|ybl|ibl|axl|paytm|upi|apl|ptyes|ptsbi|ptaxis|pthdfc)\b/gi,
  },
  {
    // Account numbers only when labelled — a bare 9–18 digit run is too ambiguous to act on.
    kind: 'bank_account',
    // The "no./number" label applies to every prefix, so it sits outside the alternation.
    regex: /\b(?:a\/c|acc(?:ount)?\.?|khata)\s*(?:no\.?|number)?\s*[:#-]?\s*\d{9,18}\b/gi,
  },
];

export function detectPii(text: string): PiiMatch[] {
  const found: PiiMatch[] = [];
  for (const { kind, regex, accept } of PATTERNS) {
    regex.lastIndex = 0;
    for (const m of text.matchAll(regex)) {
      const start = m.index ?? 0;
      if (accept && !accept(m[0])) continue;
      found.push({ kind, start, end: start + m[0].length });
    }
  }
  // An Aadhaar match also looks like a long digit run; keep the most specific, drop overlaps.
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: PiiMatch[] = [];
  for (const match of found) {
    const last = kept.at(-1);
    if (last && match.start < last.end) continue;
    kept.push(match);
  }
  return kept;
}

export function redactPii(text: string): { text: string; matches: PiiMatch[] } {
  const matches = detectPii(text);
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + `[${m.kind} removed]`;
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { text: out, matches };
}
