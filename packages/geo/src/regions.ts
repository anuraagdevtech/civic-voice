import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Boundary } from './boundary-index.ts';
import type { MultiPolygon } from './geometry.ts';

export { slug, wardKey } from './keys.ts';

/**
 * The canonical region tree: the one place that says which regions exist, what they are called in
 * which languages, and how they nest. The catalogue seed writes it to Postgres, the ingestor builds
 * its gazetteer from it, and the geolocation resolver keys its boundaries by it — so a ward cannot be
 * known to one and missing from another.
 *
 * Representative rather than complete: enough shape to exercise every code path (four rollup levels,
 * several jurisdictions, one city resolved down to real ward boundaries) without an 800k-row dataset.
 * The production loader ingests LGD, Census and ECI datasets keyed on `codes`.
 *
 * Every region has a stable `key`. Database ids are assigned at insert time and differ between
 * environments; keys do not, so data files, source registries and tests refer to regions by key.
 */

export type SeedRegionKind = 'country' | 'state' | 'district' | 'city' | 'constituency' | 'ward';

export interface SeedRegion {
  key: string;
  name: string;
  /** Names in other scripts, by BCP-47 language code. */
  names?: Record<string, string>;
  /** Other ways documents refer to it ("GHMC", "Hyderabad"). Used by the gazetteer, not displayed. */
  aliases?: string[];
  kind: SeedRegionKind;
  /** Null where no trustworthy figure exists; never invented. */
  population: number | null;
  codes: Record<string, string>;
  children?: SeedRegion[];
}

interface WardFile {
  source: string;
  license: string;
  snapshot: string | null;
  wards: Array<{
    key: string;
    number: number;
    name: string;
    osm: string | null;
    shape: MultiPolygon;
  }>;
}

const WARD_FILE = fileURLToPath(new URL('../data/ghmc-wards.json', import.meta.url));
let wardFile: WardFile | null = null;
function loadWardFile(): WardFile {
  wardFile ??= JSON.parse(readFileSync(WARD_FILE, 'utf8')) as WardFile;
  return wardFile;
}

/**
 * GHMC's wards, from the OpenStreetMap boundaries in data/ghmc-wards.json (ODbL; see
 * data/ATTRIBUTION.md). Ward populations are not in that data and are left null rather than
 * estimated. Two relations in the source both claim ward 37 (Rein Bazar and Kurmaguda); wards are
 * keyed by name, so both are kept, and the number is recorded as the source gives it.
 */
const GHMC_WARDS: SeedRegion[] = loadWardFile().wards.map((w) => ({
  key: w.key,
  name: w.name,
  aliases: [`Ward ${w.number} ${w.name}`, `Ward No. ${w.number} ${w.name}`],
  kind: 'ward',
  population: null,
  codes: { ghmc_ward: String(w.number), ...(w.osm ? { osm: w.osm } : {}) },
}));

/** Ward boundaries for the geolocation resolver, keyed by region key. */
export function wardBoundaries(): Boundary[] {
  return loadWardFile().wards.map((w) => ({ key: w.key, shape: w.shape }));
}

export function boundaryProvenance(): {
  source: string;
  license: string;
  snapshot: string | null;
  wards: number;
} {
  const f = loadWardFile();
  return { source: f.source, license: f.license, snapshot: f.snapshot, wards: f.wards.length };
}

/** Populations are 2011 Census / current projections, rounded; null where there is no trustworthy figure. */
export const GEOGRAPHY: SeedRegion = {
  key: 'IN',
  name: 'India',
  names: { hi: 'भारत', te: 'భారతదేశం' },
  kind: 'country',
  population: 1_428_600_000,
  codes: { iso: 'IN' },
  children: [
    {
      key: 'IN-UP',
      name: 'Uttar Pradesh',
      kind: 'state',
      population: 241_000_000,
      codes: { lgd: '09' },
      children: [
        {
          key: 'IN-UP-lucknow',
          name: 'Lucknow',
          kind: 'district',
          population: 4_589_838,
          codes: { lgd: '0161' },
          children: [
            {
              key: 'IN-UP-lucknow-cantt',
              name: 'Lucknow Cantt',
              kind: 'constituency',
              population: 420_000,
              codes: { eci: 'AC-173' },
            },
            {
              key: 'IN-UP-sarojini-nagar',
              name: 'Sarojini Nagar',
              kind: 'constituency',
              population: 610_000,
              codes: { eci: 'AC-175' },
            },
          ],
        },
        {
          key: 'IN-UP-varanasi',
          name: 'Varanasi',
          kind: 'district',
          population: 3_676_841,
          codes: { lgd: '0167' },
          children: [
            {
              key: 'IN-UP-varanasi-north',
              name: 'Varanasi North',
              kind: 'constituency',
              population: 380_000,
              codes: { eci: 'AC-388' },
            },
            {
              key: 'IN-UP-varanasi-south',
              name: 'Varanasi South',
              kind: 'constituency',
              population: 365_000,
              codes: { eci: 'AC-389' },
            },
          ],
        },
      ],
    },
    {
      key: 'IN-TG',
      name: 'Telangana',
      names: { te: 'తెలంగాణ', hi: 'तेलंगाना', ur: 'تلنگانہ' },
      aliases: [
        'Warangal',
        'Hanumakonda',
        'Karimnagar',
        'Nizamabad',
        'Khammam',
        'Nalgonda',
        'Mahbubnagar',
        'Adilabad',
        'Siddipet',
        'Sangareddy',
        'Suryapet',
        'Ramagundam',
      ],
      kind: 'state',
      population: 35_000_000,
      codes: { lgd: '36', iso: 'IN-TG' },
      children: [
        {
          // A municipal corporation, not a district: GHMC spans parts of four districts, and it — not
          // any one district — is who builds the drains and fixes the roads its wards complain about.
          // It sits at district depth so its wards take the fourth rollup level (ADR-0010).
          key: 'IN-TG-GHMC',
          name: 'Greater Hyderabad',
          names: { te: 'గ్రేటర్ హైదరాబాద్', hi: 'ग्रेटर हैदराबाद', ur: 'گریٹر حیدرآباد' },
          aliases: [
            'Hyderabad',
            'GHMC',
            'Greater Hyderabad Municipal Corporation',
            'హైదరాబాద్',
            'हैदराबाद',
            'حیدرآباد',
          ],
          kind: 'city',
          population: 6_810_000,
          codes: { key: 'IN-TG-GHMC' },
          children: GHMC_WARDS,
        },
      ],
    },
    {
      key: 'IN-AP',
      name: 'Andhra Pradesh',
      names: { te: 'ఆంధ్రప్రదేశ్', hi: 'आंध्र प्रदेश' },
      aliases: [
        'Vijayawada',
        'Visakhapatnam',
        'Vizag',
        'Guntur',
        'Tirupati',
        'Nellore',
        'Kurnool',
        'Kakinada',
        'Rajahmundry',
        'Rajamahendravaram',
        'Amaravati',
        'Anantapur',
        'Kadapa',
        'Eluru',
        'Ongole',
      ],
      kind: 'state',
      population: 49_400_000,
      codes: { lgd: '28', iso: 'IN-AP' },
    },
    {
      key: 'IN-MH',
      name: 'Maharashtra',
      kind: 'state',
      population: 126_000_000,
      codes: { lgd: '27' },
      children: [
        {
          key: 'IN-MH-pune',
          name: 'Pune',
          kind: 'district',
          population: 9_429_408,
          codes: { lgd: '0521' },
          children: [
            {
              key: 'IN-MH-kothrud',
              name: 'Kothrud',
              kind: 'constituency',
              population: 470_000,
              codes: { eci: 'AC-210' },
            },
            {
              key: 'IN-MH-hadapsar',
              name: 'Hadapsar',
              kind: 'constituency',
              population: 640_000,
              codes: { eci: 'AC-212' },
            },
          ],
        },
        {
          key: 'IN-MH-nagpur',
          name: 'Nagpur',
          kind: 'district',
          population: 4_653_570,
          codes: { lgd: '0497' },
          children: [
            {
              key: 'IN-MH-nagpur-south-west',
              name: 'Nagpur South West',
              kind: 'constituency',
              population: 410_000,
              codes: { eci: 'AC-052' },
            },
          ],
        },
      ],
    },
    {
      key: 'IN-KL',
      name: 'Kerala',
      kind: 'state',
      population: 35_700_000,
      codes: { lgd: '32' },
      children: [
        {
          key: 'IN-KL-ernakulam',
          name: 'Ernakulam',
          kind: 'district',
          population: 3_282_388,
          codes: { lgd: '0588' },
          children: [
            {
              key: 'IN-KL-kochi',
              name: 'Kochi',
              kind: 'constituency',
              population: 320_000,
              codes: { eci: 'AC-089' },
            },
          ],
        },
      ],
    },
    {
      // Deliberately included: the smallest UT, ~3,750x smaller than Uttar Pradesh. It is the reason
      // the system shards by citizen rather than by region (ADR-0001), and it exercises the
      // k-anonymity gate, since most demographic slices of it are below k.
      key: 'IN-LD',
      name: 'Lakshadweep',
      kind: 'state',
      population: 64_473,
      codes: { lgd: '31' },
      children: [
        {
          key: 'IN-LD-lakshadweep',
          name: 'Lakshadweep District',
          kind: 'district',
          population: 64_473,
          codes: { lgd: '0587' },
          children: [
            {
              key: 'IN-LD-kavaratti',
              name: 'Kavaratti',
              kind: 'constituency',
              population: 11_210,
              codes: { eci: 'AC-001' },
            },
          ],
        },
      ],
    },
  ],
};

export interface FlatRegion extends Omit<SeedRegion, 'children'> {
  parentKey: string | null;
  /** Keys, root first, inclusive of self. */
  keyPath: string[];
}

/** Depth-first, parents before children — the order they must be inserted in. */
export function flattenRegions(root: SeedRegion = GEOGRAPHY): FlatRegion[] {
  const out: FlatRegion[] = [];
  const walk = (node: SeedRegion, parent: FlatRegion | null) => {
    const { children, ...rest } = node;
    const flat: FlatRegion = {
      ...rest,
      parentKey: parent?.key ?? null,
      keyPath: [...(parent?.keyPath ?? []), node.key],
    };
    out.push(flat);
    for (const child of children ?? []) walk(child, flat);
  };
  walk(root, null);
  return out;
}

export interface GazetteerSeed {
  regionId: number;
  path: number[];
  names: string[];
  /** A region whose name only counts when this ancestor is in play (see `gazetteerSeeds`). */
  requires?: number;
  /** The only names precise enough to scope a document to this region on their own. */
  precise?: string[];
}

/**
 * Gazetteer entries for the ingestor, given the database ids the keys were assigned.
 *
 * Ward names are ordinary words and ordinary place names elsewhere ("Gandhinagar", "Uppal",
 * "Red Hills"), so a ward is only recognised in a document that is already about its city — issued
 * by it, or naming it. Otherwise a Gujarat press release would land in a Hyderabad ward's feed.
 *
 * States carry the names of their major cities and district headquarters as aliases, although those
 * places are not modelled as regions yet: "NH-65 between Hyderabad and Vijayawada" must be known to
 * span two states, or it would be scoped to Hyderabad alone.
 */
export function gazetteerSeeds(
  idByKey: ReadonlyMap<string, number>,
  root: SeedRegion = GEOGRAPHY,
): GazetteerSeed[] {
  const out: GazetteerSeed[] = [];
  for (const r of flattenRegions(root)) {
    const path = r.keyPath.map((k) => idByKey.get(k));
    if (path.some((id) => id === undefined)) continue;
    const ids = path as number[];
    const names = [r.name, ...Object.values(r.names ?? {}), ...(r.aliases ?? [])];
    const ward = r.kind === 'ward';
    const parentId = ward ? ids.at(-2) : undefined;
    out.push({
      regionId: ids.at(-1) as number,
      path: ids,
      names,
      ...(parentId !== undefined ? { requires: parentId } : {}),
      // GHMC's zones share names with wards ("Khairatabad" is both), so only "Ward 91 Khairatabad"
      // scopes a document to the ward; a bare name scopes it to the city and still tags the ward.
      ...(ward ? { precise: r.aliases ?? [] } : {}),
    });
  }
  return out;
}

/** Stable ids by traversal order, for tests and tools that run without a database. */
export function syntheticIds(root: SeedRegion = GEOGRAPHY): Map<string, number> {
  return new Map(flattenRegions(root).map((r, i) => [r.key, i + 1]));
}
