#!/usr/bin/env node
/**
 * Seeds a development catalogue with a representative slice of real Indian administrative geography,
 * central schemes and public authorities.
 *
 * Representative rather than complete: enough shape to exercise every code path (four rollup levels,
 * multiple jurisdictions, schemes with real budget structure) without shipping an 800k-row dataset.
 * The production loader ingests LGD, Census and ECI datasets keyed on the `codes` column.
 *
 *   node packages/db/src/cli/seed.ts
 */
import { Client } from 'pg';
import { loadDbConfig } from '../config.ts';

interface SeedRegion {
  name: string;
  kind: 'country' | 'state' | 'district' | 'constituency' | 'ward';
  population: number;
  codes: Record<string, string>;
  children?: SeedRegion[];
}

/** Populations are 2011 Census / current projections, rounded. */
const GEOGRAPHY: SeedRegion = {
  name: 'India',
  kind: 'country',
  population: 1_428_600_000,
  codes: { iso: 'IN' },
  children: [
    {
      name: 'Uttar Pradesh', kind: 'state', population: 241_000_000, codes: { lgd: '09' },
      children: [
        {
          name: 'Lucknow', kind: 'district', population: 4_589_838, codes: { lgd: '0161' },
          children: [
            { name: 'Lucknow Cantt', kind: 'constituency', population: 420_000, codes: { eci: 'AC-173' } },
            { name: 'Sarojini Nagar', kind: 'constituency', population: 610_000, codes: { eci: 'AC-175' } },
          ],
        },
        {
          name: 'Varanasi', kind: 'district', population: 3_676_841, codes: { lgd: '0167' },
          children: [
            { name: 'Varanasi North', kind: 'constituency', population: 380_000, codes: { eci: 'AC-388' } },
            { name: 'Varanasi South', kind: 'constituency', population: 365_000, codes: { eci: 'AC-389' } },
          ],
        },
      ],
    },
    {
      name: 'Maharashtra', kind: 'state', population: 126_000_000, codes: { lgd: '27' },
      children: [
        {
          name: 'Pune', kind: 'district', population: 9_429_408, codes: { lgd: '0521' },
          children: [
            { name: 'Kothrud', kind: 'constituency', population: 470_000, codes: { eci: 'AC-210' } },
            { name: 'Hadapsar', kind: 'constituency', population: 640_000, codes: { eci: 'AC-212' } },
          ],
        },
        {
          name: 'Nagpur', kind: 'district', population: 4_653_570, codes: { lgd: '0497' },
          children: [
            { name: 'Nagpur South West', kind: 'constituency', population: 410_000, codes: { eci: 'AC-052' } },
          ],
        },
      ],
    },
    {
      name: 'Kerala', kind: 'state', population: 35_700_000, codes: { lgd: '32' },
      children: [
        {
          name: 'Ernakulam', kind: 'district', population: 3_282_388, codes: { lgd: '0588' },
          children: [
            { name: 'Kochi', kind: 'constituency', population: 320_000, codes: { eci: 'AC-089' } },
          ],
        },
      ],
    },
    {
      // Deliberately included: the smallest UT, ~3,750x smaller than Uttar Pradesh. It is the reason
      // the system shards by citizen rather than by region (ADR-0001), and it exercises the
      // k-anonymity gate, since most demographic slices of it are below k.
      name: 'Lakshadweep', kind: 'state', population: 64_473, codes: { lgd: '31' },
      children: [
        {
          name: 'Lakshadweep District', kind: 'district', population: 64_473, codes: { lgd: '0587' },
          children: [
            { name: 'Kavaratti', kind: 'constituency', population: 11_210, codes: { eci: 'AC-001' } },
          ],
        },
      ],
    },
  ],
};

const SCHEMES = [
  { name: 'Mahatma Gandhi National Rural Employment Guarantee Scheme', ministry: 'Ministry of Rural Development', sector: 'Employment' },
  { name: 'PM-KISAN', ministry: 'Ministry of Agriculture and Farmers Welfare', sector: 'Agriculture' },
  { name: 'Jal Jeevan Mission', ministry: 'Ministry of Jal Shakti', sector: 'Water and Sanitation' },
  { name: 'Ayushman Bharat PM-JAY', ministry: 'Ministry of Health and Family Welfare', sector: 'Health' },
  { name: 'Pradhan Mantri Awas Yojana — Gramin', ministry: 'Ministry of Rural Development', sector: 'Housing' },
  { name: 'Samagra Shiksha', ministry: 'Ministry of Education', sector: 'Education' },
];

const AUTHORITIES = [
  { name: 'Ministry of Rural Development', kind: 'union_ministry', region: 'India', pio: 'pio-mord@gov.in', faa: 'faa-mord@gov.in' },
  { name: 'Ministry of Jal Shakti', kind: 'union_ministry', region: 'India', pio: 'pio-jalshakti@gov.in', faa: 'faa-jalshakti@gov.in' },
  { name: 'Ministry of Health and Family Welfare', kind: 'union_ministry', region: 'India', pio: 'pio-mohfw@gov.in', faa: 'faa-mohfw@gov.in' },
  { name: 'UP Department of Panchayati Raj', kind: 'state_department', region: 'Uttar Pradesh', pio: 'pio-uppr@up.gov.in', faa: 'faa-uppr@up.gov.in' },
  { name: 'Pune Municipal Corporation', kind: 'municipal_body', region: 'Pune', pio: 'pio@punecorporation.org', faa: 'faa@punecorporation.org' },
  { name: 'Kerala Water Authority', kind: 'psu', region: 'Kerala', pio: 'pio@kwa.kerala.gov.in', faa: 'faa@kwa.kerala.gov.in' },
];

async function insertRegions(client: Client, node: SeedRegion, parentId: number | null, parentPath: number[]) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO civic_catalogue.region (parent_id, kind, path, name, population, codes)
     VALUES ($1, $2, '{}'::bigint[], $3, $4, $5) RETURNING id`,
    [parentId, node.kind, node.name, node.population, JSON.stringify(node.codes)],
  );
  const id = Number(rows[0]?.id);
  const path = [...parentPath, id];
  // The path includes the row's own id, so it can only be written after the id exists.
  await client.query(`UPDATE civic_catalogue.region SET path = $2 WHERE id = $1`, [id, path]);

  for (const child of node.children ?? []) {
    await insertRegions(client, child, id, path);
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
    await insertRegions(client, GEOGRAPHY, null, []);

    const regionIdByName = new Map<string, number>();
    const { rows: regions } = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM civic_catalogue.region',
    );
    for (const r of regions) regionIdByName.set(r.name, Number(r.id));

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
      const regionId = regionIdByName.get(a.region);
      if (regionId === undefined) throw new Error(`unknown region for authority: ${a.region}`);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO civic_catalogue.authority (kind, name, region_id, pio_contact, faa_contact)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [a.kind, a.name, regionId, a.pio, a.faa],
      );
      authorityIdByName.set(a.name, Number(rows[0]?.id));
    }

    const topics: Array<[string, string, string, string, string | null, string | null, string]> = [
      ['scheme', 'Jal Jeevan Mission: piped water to every rural household', 'India',
        'Ministry of Jal Shakti', 'Jal Jeevan Mission', '2019-08-15',
        'Mission to provide functional household tap connections to every rural household.'],
      ['scheme', 'MGNREGS wage revision for FY 2026-27', 'India',
        'Ministry of Rural Development', 'Mahatma Gandhi National Rural Employment Guarantee Scheme',
        '2026-04-01', 'Annual notification of revised MGNREGS wage rates by state.'],
      ['policy', 'Ayushman Bharat coverage extended to citizens above 70', 'India',
        'Ministry of Health and Family Welfare', 'Ayushman Bharat PM-JAY', '2024-10-29',
        'Health cover extended irrespective of income for citizens aged 70 and above.'],
      ['decision', 'Pune: property tax revision for FY 2026-27', 'Pune',
        'Pune Municipal Corporation', null, '2026-04-01',
        'Revision of ready-reckoner rates used to compute municipal property tax.'],
      ['project', 'Lucknow: Gomti riverfront phase III', 'Lucknow',
        'UP Department of Panchayati Raj', null, '2025-11-01',
        'Third phase of riverfront development, including sewage interception.'],
      ['decision', 'Kerala: revised water tariff slabs', 'Kerala',
        'Kerala Water Authority', 'Jal Jeevan Mission', '2026-01-01',
        'Revision of domestic and commercial water tariff slabs.'],
      ['law', 'Uttar Pradesh: local body ward delimitation order', 'Uttar Pradesh',
        'UP Department of Panchayati Raj', null, '2026-02-15',
        'Delimitation of urban local body wards ahead of local elections.'],
    ];

    for (const [kind, title, region, authority, scheme, from, summary] of topics) {
      const regionId = regionIdByName.get(region);
      if (regionId === undefined) throw new Error(`unknown region for topic: ${region}`);
      await client.query(
        `INSERT INTO civic_catalogue.topic
           (kind, status, jurisdiction_region_id, authority_id, scheme_id, title, summary, effective_from, source_refs)
         VALUES ($1, 'active', $2, $3, $4, $5, $6, $7, $8)`,
        [
          kind, regionId, authorityIdByName.get(authority) ?? null,
          scheme ? (schemeIdByName.get(scheme) ?? null) : null,
          title, summary, from,
          JSON.stringify([`https://example.gov.in/notifications/${encodeURIComponent(title).slice(0, 40)}`]),
        ],
      );
    }

    // Budget lines. Figures are illustrative but structurally real: BE → RE → released → utilised,
    // with utilisation always at or below what was released.
    const fy = '2026-27';
    const budget: Array<[string, string, string, number, number, number, number]> = [
      ['Jal Jeevan Mission', 'Uttar Pradesh', 'state', 220_000_000_000, 231_000_000_000, 168_000_000_000, 141_200_000_000],
      ['Jal Jeevan Mission', 'Maharashtra', 'state', 138_000_000_000, 138_000_000_000, 121_400_000_000, 109_700_000_000],
      ['Jal Jeevan Mission', 'Kerala', 'state', 41_000_000_000, 39_500_000_000, 31_200_000_000, 22_900_000_000],
      ['Jal Jeevan Mission', 'Lakshadweep', 'state', 940_000_000, 940_000_000, 720_000_000, 610_000_000],
      ['Mahatma Gandhi National Rural Employment Guarantee Scheme', 'Uttar Pradesh', 'state', 96_000_000_000, 104_000_000_000, 98_500_000_000, 95_100_000_000],
      ['Ayushman Bharat PM-JAY', 'Uttar Pradesh', 'state', 58_000_000_000, 58_000_000_000, 44_200_000_000, 39_800_000_000],
      ['Ayushman Bharat PM-JAY', 'Kerala', 'state', 22_000_000_000, 23_500_000_000, 21_100_000_000, 20_400_000_000],
      ['Samagra Shiksha', 'Maharashtra', 'state', 74_000_000_000, 74_000_000_000, 61_000_000_000, 52_300_000_000],
      ['Pradhan Mantri Awas Yojana — Gramin', 'Uttar Pradesh', 'state', 112_000_000_000, 119_000_000_000, 101_000_000_000, 88_600_000_000],
      ['PM-KISAN', 'Maharashtra', 'state', 68_000_000_000, 68_000_000_000, 67_100_000_000, 66_900_000_000],
    ];

    for (const [scheme, region, level, be, re, released, utilised] of budget) {
      const schemeId = schemeIdByName.get(scheme);
      const regionId = regionIdByName.get(region);
      if (schemeId === undefined || regionId === undefined) {
        throw new Error(`unknown scheme/region for budget line: ${scheme} / ${region}`);
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO civic_catalogue.budget_line
           (fy, scheme_id, region_id, level, allocated_be, revised_re, released, utilised, source_refs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [fy, schemeId, regionId, level, be, re, released, utilised,
         JSON.stringify(['https://www.indiabudget.gov.in/doc/eb/sbe.pdf'])],
      );
      // Two dated observations, so a series exists and a revision is visible rather than overwritten.
      const budgetLineId = Number(rows[0]?.id);
      await client.query(
        `INSERT INTO civic_catalogue.utilisation (budget_line_id, as_of, released, utilised, source_ref)
         VALUES ($1, $2, $3, $4, $5), ($1, $6, $7, $8, $5)`,
        [budgetLineId, '2026-09-30', released * 0.55, utilised * 0.48,
         'https://www.indiabudget.gov.in/doc/eb/sbe.pdf', '2027-03-31', released, utilised],
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
