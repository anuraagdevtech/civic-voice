#!/usr/bin/env node
/**
 * Seeds a development catalogue with a representative slice of real Indian administrative geography
 * (the tree in @civic-voice/geo, including Greater Hyderabad's wards), central schemes and public
 * authorities.
 *
 * Representative rather than complete: enough shape to exercise every code path (four rollup levels,
 * multiple jurisdictions, schemes with real budget structure) without shipping an 800k-row dataset.
 * The production loader ingests LGD, Census and ECI datasets keyed on the `codes` column.
 *
 *   node packages/db/src/cli/seed.ts
 */
import { Client } from 'pg';
import { GEOGRAPHY, type SeedRegion } from '@civic-voice/geo';
import { loadDbConfig } from '../config.ts';

const SCHEMES = [
  {
    name: 'Mahatma Gandhi National Rural Employment Guarantee Scheme',
    ministry: 'Ministry of Rural Development',
    sector: 'Employment',
  },
  {
    name: 'PM-KISAN',
    ministry: 'Ministry of Agriculture and Farmers Welfare',
    sector: 'Agriculture',
  },
  {
    name: 'Jal Jeevan Mission',
    ministry: 'Ministry of Jal Shakti',
    sector: 'Water and Sanitation',
  },
  {
    name: 'Ayushman Bharat PM-JAY',
    ministry: 'Ministry of Health and Family Welfare',
    sector: 'Health',
  },
  {
    name: 'Pradhan Mantri Awas Yojana — Gramin',
    ministry: 'Ministry of Rural Development',
    sector: 'Housing',
  },
  { name: 'Samagra Shiksha', ministry: 'Ministry of Education', sector: 'Education' },
];

/**
 * Public information officers and first appellate authorities are not listed here: each authority
 * publishes its own under RTI Act §4(1)(b), and an invented address that looks official would send a
 * citizen's request nowhere. The production loader takes them from those published lists.
 */
const AUTHORITIES: Array<{
  name: string;
  kind: string;
  region: string;
  pio: string | null;
  faa: string | null;
}> = [
  {
    name: 'Ministry of Rural Development',
    kind: 'union_ministry',
    region: 'India',
    pio: null,
    faa: null,
  },
  {
    name: 'Ministry of Jal Shakti',
    kind: 'union_ministry',
    region: 'India',
    pio: null,
    faa: null,
  },
  {
    name: 'Ministry of Health and Family Welfare',
    kind: 'union_ministry',
    region: 'India',
    pio: null,
    faa: null,
  },
  {
    name: 'UP Department of Panchayati Raj',
    kind: 'state_department',
    region: 'Uttar Pradesh',
    pio: null,
    faa: null,
  },
  {
    name: 'Pune Municipal Corporation',
    kind: 'municipal_body',
    region: 'Pune',
    pio: null,
    faa: null,
  },
  {
    name: 'Kerala Water Authority',
    kind: 'psu',
    region: 'Kerala',
    pio: null,
    faa: null,
  },
];

async function insertRegions(
  client: Client,
  node: SeedRegion,
  parentId: number | null,
  parentPath: number[],
  idByKey: Map<string, number>,
) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO civic_catalogue.region (parent_id, kind, path, name, names, population, codes)
     VALUES ($1, $2, '{}'::bigint[], $3, $4, $5, $6) RETURNING id`,
    [
      parentId,
      node.kind,
      node.name,
      JSON.stringify(node.names ?? {}),
      node.population,
      // The stable key goes in `codes`, beside LGD/ECI codes, so data files can find the row.
      JSON.stringify({ ...node.codes, key: node.key }),
    ],
  );
  const id = Number(rows[0]?.id);
  const path = [...parentPath, id];
  // The path includes the row's own id, so it can only be written after the id exists.
  await client.query(`UPDATE civic_catalogue.region SET path = $2 WHERE id = $1`, [id, path]);
  idByKey.set(node.key, id);

  for (const child of node.children ?? []) {
    await insertRegions(client, child, id, path, idByKey);
  }
  return id;
}

async function main() {
  const config = loadDbConfig();
  const client = new Client({ connectionString: config.catalogueUrl });
  await client.connect();

  try {
    const { rows: existing } = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM civic_catalogue.region',
    );
    if (Number(existing[0]?.n ?? 0) > 0) {
      console.log('catalogue already seeded; nothing to do');
      return;
    }

    await client.query('BEGIN');
    const idByKey = new Map<string, number>();
    await insertRegions(client, GEOGRAPHY, null, [], idByKey);

    // The seed data below names regions in prose ("Pune"); a name shared by two regions (a ward and a
    // district, say) is refused rather than resolved to whichever row came first.
    const regionIdByName = new Map<string, number | 'ambiguous'>();
    const { rows: regions } = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM civic_catalogue.region',
    );
    for (const r of regions)
      regionIdByName.set(r.name, regionIdByName.has(r.name) ? 'ambiguous' : Number(r.id));
    const regionIdOf = (name: string, what: string): number => {
      const id = regionIdByName.get(name);
      if (id === undefined || id === 'ambiguous')
        throw new Error(`${id ?? 'unknown'} region for ${what}: ${name}`);
      return id;
    };

    const schemeIdByName = new Map<string, number>();
    for (const scheme of SCHEMES) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO civic_catalogue.scheme (name, ministry, sector) VALUES ($1, $2, $3) RETURNING id`,
        [scheme.name, scheme.ministry, scheme.sector],
      );
      schemeIdByName.set(scheme.name, Number(rows[0]?.id));
    }

    const authorityIdByName = new Map<string, number>();
    for (const a of AUTHORITIES) {
      const regionId = regionIdOf(a.region, 'authority');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO civic_catalogue.authority (kind, name, region_id, pio_contact, faa_contact)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [a.kind, a.name, regionId, a.pio, a.faa],
      );
      authorityIdByName.set(a.name, Number(rows[0]?.id));
    }

    const topics: Array<[string, string, string, string, string | null, string | null, string]> = [
      [
        'scheme',
        'Jal Jeevan Mission: piped water to every rural household',
        'India',
        'Ministry of Jal Shakti',
        'Jal Jeevan Mission',
        '2019-08-15',
        'Mission to provide functional household tap connections to every rural household.',
      ],
      [
        'scheme',
        'MGNREGS wage revision for FY 2026-27',
        'India',
        'Ministry of Rural Development',
        'Mahatma Gandhi National Rural Employment Guarantee Scheme',
        '2026-04-01',
        'Annual notification of revised MGNREGS wage rates by state.',
      ],
      [
        'policy',
        'Ayushman Bharat coverage extended to citizens above 70',
        'India',
        'Ministry of Health and Family Welfare',
        'Ayushman Bharat PM-JAY',
        '2024-10-29',
        'Health cover extended irrespective of income for citizens aged 70 and above.',
      ],
      [
        'decision',
        'Pune: property tax revision for FY 2026-27',
        'Pune',
        'Pune Municipal Corporation',
        null,
        '2026-04-01',
        'Revision of ready-reckoner rates used to compute municipal property tax.',
      ],
      [
        'project',
        'Lucknow: Gomti riverfront phase III',
        'Lucknow',
        'UP Department of Panchayati Raj',
        null,
        '2025-11-01',
        'Third phase of riverfront development, including sewage interception.',
      ],
      [
        'decision',
        'Kerala: revised water tariff slabs',
        'Kerala',
        'Kerala Water Authority',
        'Jal Jeevan Mission',
        '2026-01-01',
        'Revision of domestic and commercial water tariff slabs.',
      ],
      [
        'law',
        'Uttar Pradesh: local body ward delimitation order',
        'Uttar Pradesh',
        'UP Department of Panchayati Raj',
        null,
        '2026-02-15',
        'Delimitation of urban local body wards ahead of local elections.',
      ],
    ];

    // The spending head each is about, set by hand here; ingested topics get theirs from the need lexicon.
    const sectorOf: Record<string, string> = {
      'Jal Jeevan Mission: piped water to every rural household': 'water_sanitation',
      'MGNREGS wage revision for FY 2026-27': 'rural_development',
      'Ayushman Bharat coverage extended to citizens above 70': 'health',
      'Lucknow: Gomti riverfront phase III': 'housing_urban',
      'Kerala: revised water tariff slabs': 'water_sanitation',
    };

    for (const [kind, title, region, authority, scheme, from, summary] of topics) {
      const regionId = regionIdOf(region, 'topic');
      await client.query(
        `INSERT INTO civic_catalogue.topic
           (kind, status, jurisdiction_region_id, authority_id, scheme_id, title, summary, effective_from, source_refs, sector)
         VALUES ($1, 'active', $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          kind,
          regionId,
          authorityIdByName.get(authority) ?? null,
          scheme ? (schemeIdByName.get(scheme) ?? null) : null,
          title,
          summary,
          from,
          JSON.stringify([
            `https://example.gov.in/notifications/${encodeURIComponent(title).slice(0, 40)}`,
          ]),
          sectorOf[title] ?? null,
        ],
      );
    }

    // Budget lines. Figures are illustrative but structurally real: BE → RE → released → utilised,
    // with utilisation always at or below what was released.
    const fy = '2026-27';
    const budget: Array<[string, string, string, number, number, number, number]> = [
      [
        'Jal Jeevan Mission',
        'Uttar Pradesh',
        'state',
        220_000_000_000,
        231_000_000_000,
        168_000_000_000,
        141_200_000_000,
      ],
      [
        'Jal Jeevan Mission',
        'Maharashtra',
        'state',
        138_000_000_000,
        138_000_000_000,
        121_400_000_000,
        109_700_000_000,
      ],
      [
        'Jal Jeevan Mission',
        'Kerala',
        'state',
        41_000_000_000,
        39_500_000_000,
        31_200_000_000,
        22_900_000_000,
      ],
      [
        'Jal Jeevan Mission',
        'Lakshadweep',
        'state',
        940_000_000,
        940_000_000,
        720_000_000,
        610_000_000,
      ],
      [
        'Mahatma Gandhi National Rural Employment Guarantee Scheme',
        'Uttar Pradesh',
        'state',
        96_000_000_000,
        104_000_000_000,
        98_500_000_000,
        95_100_000_000,
      ],
      [
        'Ayushman Bharat PM-JAY',
        'Uttar Pradesh',
        'state',
        58_000_000_000,
        58_000_000_000,
        44_200_000_000,
        39_800_000_000,
      ],
      [
        'Ayushman Bharat PM-JAY',
        'Kerala',
        'state',
        22_000_000_000,
        23_500_000_000,
        21_100_000_000,
        20_400_000_000,
      ],
      [
        'Samagra Shiksha',
        'Maharashtra',
        'state',
        74_000_000_000,
        74_000_000_000,
        61_000_000_000,
        52_300_000_000,
      ],
      [
        'Pradhan Mantri Awas Yojana — Gramin',
        'Uttar Pradesh',
        'state',
        112_000_000_000,
        119_000_000_000,
        101_000_000_000,
        88_600_000_000,
      ],
      [
        'PM-KISAN',
        'Maharashtra',
        'state',
        68_000_000_000,
        68_000_000_000,
        67_100_000_000,
        66_900_000_000,
      ],
    ];

    for (const [scheme, region, level, be, re, released, utilised] of budget) {
      const schemeId = schemeIdByName.get(scheme);
      const regionId = regionIdOf(region, 'budget line');
      if (schemeId === undefined) throw new Error(`unknown scheme for budget line: ${scheme}`);
      const { rows } = await client.query<{ id: string }>(
        // `sample`: these figures are illustrative (see above), and the UI badges every one of them.
        `INSERT INTO civic_catalogue.budget_line
           (fy, scheme_id, region_id, level, allocated_be, revised_re, released, utilised, source_refs,
            provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'sample') RETURNING id`,
        [
          fy,
          schemeId,
          regionId,
          level,
          be,
          re,
          released,
          utilised,
          JSON.stringify(['https://www.indiabudget.gov.in/doc/eb/sbe.pdf']),
        ],
      );
      // Two dated observations, so a series exists and a revision is visible rather than overwritten.
      const budgetLineId = Number(rows[0]?.id);
      await client.query(
        `INSERT INTO civic_catalogue.utilisation (budget_line_id, as_of, released, utilised, source_ref)
         VALUES ($1, $2, $3, $4, $5), ($1, $6, $7, $8, $5)`,
        [
          budgetLineId,
          '2026-09-30',
          released * 0.55,
          utilised * 0.48,
          'https://www.indiabudget.gov.in/doc/eb/sbe.pdf',
          '2027-03-31',
          released,
          utilised,
        ],
      );
    }

    await client.query('COMMIT');

    const counts = await client.query<{ regions: string; topics: string; lines: string }>(
      `SELECT (SELECT count(*) FROM civic_catalogue.region)      AS regions,
              (SELECT count(*) FROM civic_catalogue.topic)       AS topics,
              (SELECT count(*) FROM civic_catalogue.budget_line) AS lines`,
    );
    const row = counts.rows[0];
    console.log(
      `seeded ${row?.regions} regions, ${SCHEMES.length} schemes, ${AUTHORITIES.length} authorities, ` +
        `${row?.topics} topics, ${row?.lines} budget lines`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

await main();
