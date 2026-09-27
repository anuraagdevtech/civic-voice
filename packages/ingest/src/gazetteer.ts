/**
 * Geo-tagging documents by the places they name.
 *
 * "Issues of Hyderabad need to be addressed by Hyderabad people" only works if a Hyderabad GO is known
 * to be about Hyderabad. The issuing authority gives a floor (a Telangana GO concerns Telangana); the
 * text usually says more ("storm-water drains in Khairatabad and Secunderabad"), and the most specific
 * place named is what decides who gets to discuss it.
 *
 * Precision is favoured over recall throughout. A place name that is ambiguous — several regions share
 * it and the document's own jurisdiction does not settle which — is dropped rather than guessed,
 * because a wrong geo-tag hands a decision to the wrong people.
 */

export interface GazetteerEntry {
  regionId: number;
  /** Ancestor path, root first, inclusive of self. */
  path: number[];
  names: string[];
  /**
   * An ancestor that must already be in play — the document's jurisdiction, or named in it — for this
   * name to count. Ward names are ordinary words and other places' names ("Gandhinagar", "Red
   * Hills"); they identify a ward only in a document already about that ward's city.
   */
  requires?: number;
  /**
   * The names that on their own are precise enough to scope a document to this region. When set, any
   * other name still tags the region (so its residents see the document) but only as evidence for its
   * parent. In Greater Hyderabad "Khairatabad" is a ward *and* a zone of several wards, so a bare
   * "Khairatabad" says "this city"; "Ward 91 Khairatabad" says "this ward".
   */
  precise?: string[];
}

export interface GeoTag {
  regionId: number;
  path: number[];
  confidence: number;
  matched: string;
  in: 'title' | 'body';
  /** Matched by a name that tags the region but cannot on its own scope a document to it. */
  weak?: boolean;
}

interface CompiledName {
  entry: GazetteerEntry;
  name: string;
  /** Latin names match on word boundaries; Indic names as substrings (inflection attaches to them). */
  regex: RegExp | null;
}

const isLatin = (s: string) => /^[\x00-\x7f]+$/.test(s);

export class Gazetteer {
  private readonly names: CompiledName[] = [];
  private readonly requires = new Map<number, number>();
  private readonly precise = new Map<number, Set<string>>();

  constructor(entries: readonly GazetteerEntry[]) {
    for (const entry of entries) {
      if (entry.requires !== undefined) this.requires.set(entry.regionId, entry.requires);
      if (entry.precise)
        this.precise.set(
          entry.regionId,
          new Set(entry.precise.map((n) => n.normalize('NFC').toLowerCase().trim())),
        );
      for (const raw of entry.names) {
        const name = raw.normalize('NFC').toLowerCase().trim();
        // Two-letter names match too much ("Ap" in "apply"); require three characters.
        if (name.length < 3) continue;
        const regex = isLatin(name)
          ? new RegExp(
              `(?<![a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`,
              'i',
            )
          : null;
        this.names.push({ entry, name, regex });
      }
    }
    // Longest names first, so "Greater Hyderabad" is tried before "Hyderabad".
    this.names.sort((a, b) => b.name.length - a.name.length);
  }

  get size(): number {
    return this.names.length;
  }

  private matches(text: string): Map<string, GazetteerEntry[]> {
    const lower = text.normalize('NFC').toLowerCase();
    const found = new Map<string, GazetteerEntry[]>();
    const consumed: Array<[number, number]> = [];

    for (const { entry, name, regex } of this.names) {
      let at = -1;
      if (regex) {
        const m = regex.exec(lower);
        at = m ? m.index : -1;
      } else {
        at = lower.indexOf(name);
      }
      if (at < 0) continue;
      // A shorter name inside a longer one already matched ("Hyderabad" inside "Greater Hyderabad")
      // is the same mention, not a second place.
      const end = at + name.length;
      const overlapping = consumed.some(
        ([s, e]) => at >= s && end <= e && !(at === s && end === e),
      );
      if (overlapping) continue;
      consumed.push([at, end]);
      found.set(name, [...(found.get(name) ?? []), entry]);
    }
    return found;
  }

  /**
   * Tag a document. `jurisdictionPath` is the issuing authority's region path; it disambiguates and it
   * bounds: a Telangana GO that mentions "Hyderabad" means Hyderabad, Telangana.
   */
  tag(input: {
    title: string;
    body?: string | null;
    jurisdictionPath?: readonly number[];
  }): GeoTag[] {
    const jurisdiction = input.jurisdictionPath ?? [];
    const jurisdictionRoot = jurisdiction.at(-1);
    const tags = new Map<number, GeoTag>();

    const consider = (text: string, where: 'title' | 'body') => {
      for (const [name, candidates] of this.matches(text)) {
        // Keep only candidates consistent with the jurisdiction: inside it, or one of its ancestors.
        const consistent =
          jurisdictionRoot === undefined
            ? candidates
            : candidates.filter(
                (c) => c.path.includes(jurisdictionRoot) || jurisdiction.includes(c.regionId),
              );
        const pool = consistent.length > 0 ? consistent : candidates;
        // Ambiguous even after the jurisdiction has had its say: drop it rather than guess.
        const distinct = new Set(pool.map((c) => c.regionId));
        if (distinct.size !== 1) continue;
        const entry = pool[0] as GazetteerEntry;

        const confidence = (where === 'title' ? 0.9 : 0.7) * (consistent.length > 0 ? 1 : 0.6);
        const preciseNames = this.precise.get(entry.regionId);
        const weak = preciseNames !== undefined && !preciseNames.has(name);
        const existing = tags.get(entry.regionId);
        // A precise match beats a weak one at any confidence; otherwise the stronger match wins.
        const better =
          !existing ||
          (existing.weak && !weak) ||
          (existing.weak === weak && existing.confidence < confidence);
        if (better) {
          tags.set(entry.regionId, {
            regionId: entry.regionId,
            path: entry.path,
            confidence,
            matched: name,
            in: where,
            ...(weak ? { weak: true } : {}),
          });
        }
      }
    };

    consider(input.title, 'title');
    if (input.body) consider(input.body, 'body');

    for (const regionId of [...tags.keys()]) {
      const requires = this.requires.get(regionId);
      if (requires !== undefined && !jurisdiction.includes(requires) && !tags.has(requires))
        tags.delete(regionId);
    }

    return [...tags.values()].sort(
      (a, b) => b.path.length - a.path.length || b.confidence - a.confidence,
    );
  }

  /**
   * The single region a document is primarily about, which decides whose question it is.
   *
   * The evidence is the places named in the title if there are any (titles say what an order is
   * about; bodies cite precedent and neighbours), otherwise those in the body — restricted to the
   * issuing jurisdiction. A place named alongside one of its own sub-regions ("Ward 91 Khairatabad,
   * Greater Hyderabad") is context, not a second subject. A weak tag counts as evidence for its parent. What remains is reduced to its lowest common
   * ancestor: drains in Khairatabad and Secunderabad are a Greater Hyderabad matter, and a Union
   * release naming three states is a national one. A document never gets a *narrower* scope than its
   * evidence supports; with no evidence, the jurisdiction itself is the scope, at lower confidence.
   */
  primaryRegion(
    tags: readonly GeoTag[],
    jurisdictionPath: readonly number[],
  ): { regionId: number; path: number[]; confidence: number } | null {
    const root = jurisdictionPath.at(-1);
    // A weak tag is evidence for its parent, not for itself.
    const evidential = tags.map((t) =>
      t.weak
        ? { ...t, regionId: t.path.at(-2) as number, path: t.path.slice(0, -1), weak: false }
        : t,
    );
    const inside = (
      root === undefined ? evidential : evidential.filter((t) => t.path.includes(root))
    ).filter((t) => t.path.length > 0);
    const titled = inside.filter((t) => t.in === 'title');
    const evidence = titled.length > 0 ? titled : inside;

    if (evidence.length > 0) {
      const leaves = evidence.filter(
        (t) =>
          !evidence.some(
            (o) => o !== t && o.path.length > t.path.length && o.path.includes(t.regionId),
          ),
      );
      const common: number[] = [];
      for (let depth = 0; ; depth++) {
        const at = leaves[0]?.path[depth];
        if (at === undefined || leaves.some((l) => l.path[depth] !== at)) break;
        common.push(at);
      }
      const regionId = common.at(-1);
      if (regionId !== undefined) {
        return { regionId, path: common, confidence: Math.min(...leaves.map((l) => l.confidence)) };
      }
    }
    if (root === undefined) return null;
    return { regionId: root, path: [...jurisdictionPath], confidence: 0.5 };
  }
}
