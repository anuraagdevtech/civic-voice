import { detectPii, type PiiMatch } from './pii.ts';
import { tokenize } from './text.ts';

/**
 * Automated moderation for public comments.
 *
 * Three verdicts, deliberately asymmetric in what automation may do on its own:
 *
 *  - `reject` — only for PII. Posting someone's phone number or Aadhaar is never acceptable and never
 *    ambiguous, so the machine may refuse it outright, and it tells the author exactly why.
 *  - `hold` — suspected threats, abuse or spam go to a human review queue. Automated classifiers are
 *    wrong often enough on Indian code-mixed text (and on sarcasm, and on quoted slurs being
 *    *condemned*) that letting them silently delete political speech would itself be a harm.
 *  - `allow` — published.
 *
 * The committed lexicon is a starter, intentionally small. A production deployment loads the
 * trust-and-safety team's maintained lexicon (`loadLexicon`), which is not something to keep in a
 * public repository, and routes uncertain cases to the large model (docs/adr/0011).
 *
 * Legal context: as an intermediary under the IT (Intermediary Guidelines) Rules, 2021, the platform
 * needs a grievance officer and time-bound takedown on valid complaints. The report/hold/review flow
 * is the mechanism for that; the timelines are an operational commitment, not a code property.
 */

export type ModerationVerdict = 'allow' | 'hold' | 'reject';

export type ModerationReason =
  'pii' | 'threat' | 'abuse' | 'spam_links' | 'spam_repetition' | 'shouting' | 'too_short';

export interface ModerationResult {
  verdict: ModerationVerdict;
  reasons: ModerationReason[];
  pii: PiiMatch[];
}

export interface Lexicon {
  /** Incitement to violence. Held for review — a threat against a person or group. */
  threat: string[];
  /** Personal abuse. Held for review. */
  abuse: string[];
}

/** A minimal starter lexicon. Threat phrases are matched as substrings; abuse terms as whole tokens. */
export const STARTER_LEXICON: Lexicon = {
  threat: [
    'kill them',
    'kill him',
    'kill her',
    'burn their',
    'burn them',
    'beat them up',
    'lynch',
    'maar dalo',
    'maar do',
    'jala do',
    'khatam kar do',
    'champandi',
    'champeyandi',
    'thagalabettandi',
    'मार डालो',
    'जला दो',
    'खत्म कर दो',
    'చంపండి',
    'చంపేయండి',
    'తగలబెట్టండి',
  ],
  abuse: [
    'idiot',
    'idiots',
    'moron',
    'bastard',
    'chutiya',
    'kutta',
    'kutte',
    'harami',
    'donga',
    'vedhava',
  ],
};

let lexicon: Lexicon = STARTER_LEXICON;

/** Replace the lexicon at startup with the maintained one. */
export function loadLexicon(next: Lexicon): void {
  lexicon = next;
}

export function moderate(text: string): ModerationResult {
  const reasons: ModerationReason[] = [];
  const pii = detectPii(text);
  if (pii.length > 0) reasons.push('pii');

  const lower = text.toLowerCase();
  const tokens = tokenize(text);
  const tokenSet = new Set(tokens);

  if (lexicon.threat.some((phrase) => lower.includes(phrase))) reasons.push('threat');
  if (lexicon.abuse.some((word) => tokenSet.has(word))) reasons.push('abuse');

  const links = (text.match(/https?:\/\/|www\./gi) ?? []).length;
  if (links > 2) reasons.push('spam_links');

  // The same token over and over is the signature of a copy-paste flood, not of a real complaint.
  if (tokens.length >= 8) {
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    const top = Math.max(...counts.values());
    if (top / tokens.length > 0.5) reasons.push('spam_repetition');
  }

  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 40 && letters === letters.toUpperCase()) reasons.push('shouting');

  if (text.trim().length < 3) reasons.push('too_short');

  let verdict: ModerationVerdict = 'allow';
  if (reasons.includes('pii')) verdict = 'reject';
  else if (
    reasons.some(
      (r) => r === 'threat' || r === 'abuse' || r === 'spam_links' || r === 'spam_repetition',
    )
  ) {
    verdict = 'hold';
  } else if (reasons.includes('too_short')) {
    verdict = 'reject';
  }
  // Shouting alone is rude, not harmful: it is recorded, not acted on.

  return { verdict, reasons, pii };
}
