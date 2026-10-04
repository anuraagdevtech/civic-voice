import { ROLLUP_FANOUT, type RegionKind } from '@civic-voice/contracts';

/**
 * Region-hierarchy helpers. Regions are stored with both a `parent_id` and a materialised
 * ancestor path so the two hot questions are O(1) rather than recursive:
 *
 *  - "what are this region's rollup ancestors?" — asked on *every single write*
 *  - "is region A inside region B?" — asked on every authorisation and filter
 */

export interface RegionNode {
  id: number;
  parent_id: number | null;
  kind: RegionKind;
  /** Root first, inclusive of self. */
  path: number[];
}

/**
 * The region levels an event rolls up to: the first four of the citizen's own ancestor chain
 * (country → state → district or city → constituency or city ward).
 *
 * Bounding the fan-out at 4 rather than "every region" is what makes the capacity model work
 * (docs/SCALING.md §5). Stopping at the fourth level costs no publishable information: below it sit
 * only rural wards of ~1,000 people, whose demographic slices the k-gate would suppress anyway.
 */
export function rollupAncestors(path: readonly number[]): number[] {
  return path.slice(0, ROLLUP_FANOUT);
}

export function isWithin(path: readonly number[], ancestorId: number): boolean {
  return path.includes(ancestorId);
}

/**
 * Is this region inside the topic's jurisdiction? A citizen may only be counted on a topic that
 * actually applies to them, or a state policy would acquire a national mood.
 */
export function inJurisdiction(
  citizenPath: readonly number[],
  jurisdictionRegionId: number,
): boolean {
  return isWithin(citizenPath, jurisdictionRegionId);
}

export function depth(path: readonly number[]): number {
  return path.length;
}

/** Build a path from a parent's path. Kept in one place so path construction cannot drift. */
export function childPath(parentPath: readonly number[], childId: number): number[] {
  return [...parentPath, childId];
}

/** Postgres `ltree` literal for a path, used by the catalogue queries. */
export function toLtree(path: readonly number[]): string {
  return path.map((id) => `r${id}`).join('.');
}

export function fromLtree(ltree: string): number[] {
  if (ltree === '') return [];
  return ltree.split('.').map((label) => {
    const n = Number.parseInt(label.replace(/^r/, ''), 10);
    if (!Number.isInteger(n)) throw new RangeError(`bad ltree label: ${label}`);
    return n;
  });
}
