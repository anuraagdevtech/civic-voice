import { BoundaryIndex } from './boundary-index.ts';
import { coarsen } from './geometry.ts';
import {
  flattenRegions,
  GEOGRAPHY,
  wardBoundaries,
  type FlatRegion,
  type SeedRegion,
} from './regions.ts';

/**
 * Where is this person? Answers with a region, never with a place.
 *
 * The coordinate is coarsened to three decimals (~110 m) before it is looked at, here as well as in
 * the client, and it is not returned, stored or logged: what the system keeps is the region the person
 * *confirms*. The resolver only proposes ("you appear to be in Khairatabad ward — is that right?"),
 * because a fix taken at the office is not where someone lives, and the confirmed home region is what
 * decides which local questions they may answer.
 *
 * Coarsening costs precision only within ~110 m of a ward boundary, and the person confirms or
 * corrects the proposal anyway; it buys a coordinate that cannot identify a house.
 */
export interface Resolution {
  /** The most specific region with a known boundary containing the point. */
  key: string;
  /** Root-first keys, inclusive: country → state → city → ward. */
  keyPath: string[];
  name: string;
  kind: FlatRegion['kind'];
  /** The kind of evidence: a boundary lookup, or only a coarse bounding area. */
  basis: 'boundary';
}

export const RESOLUTION_DECIMALS = 3;

/** India's extent, generously. A point outside it is not a citizen's home; it is a wrong fix. */
const INDIA = { minLng: 68, maxLng: 97.5, minLat: 6.5, maxLat: 37.5 };

export class GeoResolver {
  private readonly index: BoundaryIndex;
  private readonly byKey: Map<string, FlatRegion>;

  constructor(options: { root?: SeedRegion; boundaries?: ReturnType<typeof wardBoundaries> } = {}) {
    this.byKey = new Map(flattenRegions(options.root ?? GEOGRAPHY).map((r) => [r.key, r]));
    this.index = new BoundaryIndex(options.boundaries ?? wardBoundaries());
  }

  get boundaries(): number {
    return this.index.size;
  }

  /**
   * Null when the point is outside every boundary the system has — which today is most of India.
   * The caller then asks the person to pick their region from the list instead; it never guesses a
   * "nearest" ward, because a wrong ward is worse than an honest "we don't have your area mapped".
   */
  resolve(lat: number, lng: number): Resolution | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const cLat = coarsen(lat, RESOLUTION_DECIMALS);
    const cLng = coarsen(lng, RESOLUTION_DECIMALS);
    if (cLng < INDIA.minLng || cLng > INDIA.maxLng || cLat < INDIA.minLat || cLat > INDIA.maxLat)
      return null;
    const key = this.index.locate(cLng, cLat);
    const region = key ? this.byKey.get(key) : undefined;
    if (!region) return null;
    return {
      key: region.key,
      keyPath: region.keyPath,
      name: region.name,
      kind: region.kind,
      basis: 'boundary',
    };
  }
}
