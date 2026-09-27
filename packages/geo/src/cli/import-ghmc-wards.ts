#!/usr/bin/env node
/**
 * Regenerates data/ghmc-wards.json from an OpenStreetMap export of GHMC ward boundaries.
 *
 *   curl -fsSLo /tmp/ghmc-wards.geojson \
 *     https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Hyderabad/ghmc-wards.geojson
 *   node packages/geo/src/cli/import-ghmc-wards.ts /tmp/ghmc-wards.geojson
 *
 * The source is an Overpass export of OSM `boundary=administrative, admin_level=10` relations, so it
 * is © OpenStreetMap contributors under the ODbL; data/ATTRIBUTION.md carries the notice, and the
 * derived file must keep it. Output is simplified to ~11 m and rounded to 6 decimals (~0.1 m), which
 * loses nothing the source lines were accurate to and cuts the file to a fraction of its size.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simplifyShape, type MultiPolygon } from '../geometry.ts';
import { wardKey } from '../keys.ts';

const TOLERANCE = 0.0001;
const OUT = fileURLToPath(new URL('../../data/ghmc-wards.json', import.meta.url));

interface Feature {
  properties: Record<string, string>;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
}

const source = process.argv[2];
if (!source) {
  console.error('usage: import-ghmc-wards.ts <ghmc-wards.geojson>');
  process.exit(2);
}

const collection = JSON.parse(readFileSync(source, 'utf8')) as {
  features: Feature[];
  timestamp?: string;
};
const round = (n: number) => Math.round(n * 1e6) / 1e6;
let before = 0;
let after = 0;

const wards = collection.features
  .map((f) => {
    const match = /^Ward\s+(\d+)\s+(.+)$/.exec(f.properties.name ?? '');
    if (!match) throw new Error(`unexpected ward name: ${f.properties.name}`);
    const shape = (
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    ) as MultiPolygon;
    const simplified = simplifyShape(shape, TOLERANCE).map((p) =>
      p.map((r) => r.map(([x, y]) => [round(x), round(y)])),
    );
    before += JSON.stringify(shape).length;
    after += JSON.stringify(simplified).length;
    const name = (match[2] as string).trim();
    return {
      key: wardKey(name),
      number: Number(match[1]),
      name,
      osm: f.properties['@id'] ?? null,
      shape: simplified,
    };
  })
  .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

const keys = new Set(wards.map((w) => w.key));
if (keys.size !== wards.length) throw new Error('ward names are not unique; keys would collide');

writeFileSync(
  OUT,
  JSON.stringify({
    source: 'OpenStreetMap via datameet/Municipal_Spatial_Data (Hyderabad/ghmc-wards.geojson)',
    license: 'ODbL-1.0 — © OpenStreetMap contributors',
    snapshot: collection.timestamp ?? null,
    simplifiedTo: `${TOLERANCE} degrees`,
    wards,
  }) + '\n',
);
console.log(
  `${wards.length} wards → ${OUT} (${Math.round(before / 1024)} KiB of coordinates → ${Math.round(after / 1024)} KiB)`,
);
