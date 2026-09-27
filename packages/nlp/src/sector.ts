import { NEED_SECTOR, NEEDS, type Need, type ProgrammeSector } from '@civic-voice/contracts';
import { lexiconNeeds } from './needs.ts';
import { normalize, tokenize } from './text.ts';

/**
 * The spending sector a document or an issue is about, from the same need lexicon the comment model
 * uses — so "a topic about drinking water" and "a comment asking for drinking water" land on the same
 * budget head. The need with the most lexicon hits wins; ties go to the earlier need in the
 * vocabulary, so the answer is deterministic. Null when nothing matches or the only match has no
 * budget head (corruption, environment): an unclassified topic is better than a wrong one, and can be
 * set by hand.
 */
export function sectorFor(text: string): ProgrammeSector | null {
  const hits = lexiconNeeds(tokenize(normalize(text)), text.normalize('NFC').toLowerCase());
  let best: Need | null = null;
  for (const need of NEEDS) {
    const n = hits.get(need) ?? 0;
    if (n === 0 || NEED_SECTOR[need] === null) continue;
    if (best === null || n > (hits.get(best) ?? 0)) best = need;
  }
  return best === null ? null : NEED_SECTOR[best];
}
