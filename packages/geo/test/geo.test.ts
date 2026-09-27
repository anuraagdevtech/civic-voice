import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BoundaryIndex,
  boundaryProvenance,
  coarsen,
  flattenRegions,
  gazetteerSeeds,
  GeoResolver,
  pointInPolygon,
  pointInRing,
  simplifyRing,
  syntheticIds,
  wardBoundaries,
  type Polygon,
  type Position,
  type Ring,
} from '../src/index.ts';

const square = (x0: number, y0: number, size: number): Ring => [
  [x0, y0],
  [x0 + size, y0],
  [x0 + size, y0 + size],
  [x0, y0 + size],
  [x0, y0],
];

describe('geometry', () => {
  test('point in ring', () => {
    const ring = square(0, 0, 1);
    assert.equal(pointInRing(ring, 0.5, 0.5), true);
    assert.equal(pointInRing(ring, 1.5, 0.5), false);
    assert.equal(pointInRing(ring, -0.1, 0.5), false);
  });

  test('a point in a hole is outside the polygon', () => {
    const donut: Polygon = [square(0, 0, 10), square(4, 4, 2)];
    assert.equal(pointInPolygon(donut, 1, 1), true);
    assert.equal(pointInPolygon(donut, 5, 5), false);
  });

  test('concave shapes', () => {
    // A "U": the notch between the arms is outside.
    const u: Ring = [
      [0, 0],
      [3, 0],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
      [0, 0],
    ];
    assert.equal(pointInRing(u, 0.5, 2), true);
    assert.equal(pointInRing(u, 1.5, 2), false);
    assert.equal(pointInRing(u, 1.5, 0.5), true);
  });

  test('simplification drops collinear points and keeps the ring closed', () => {
    const dense: Position[] = [];
    for (let i = 0; i <= 100; i++) dense.push([i / 100, 0]);
    dense.push([1, 1], [0, 1], [0, 0]);
    const simple = simplifyRing(dense, 0.001);
    assert.ok(simple.length <= 6, `expected a near-square, got ${simple.length} points`);
    assert.deepEqual(simple[0], simple.at(-1));
  });

  test('simplification never collapses a ring below a triangle', () => {
    const tiny = square(0, 0, 0.00001);
    assert.equal(simplifyRing(tiny, 1).length, 5);
  });

  test('coarsening to three decimals', () => {
    assert.equal(coarsen(17.412_345), 17.412);
    assert.equal(coarsen(78.460_51), 78.461);
  });
});

describe('boundary index', () => {
  test('the smallest containing boundary wins', () => {
    const idx = new BoundaryIndex([
      { key: 'city', shape: [[square(0, 0, 0.1)]] },
      { key: 'ward', shape: [[square(0.02, 0.02, 0.01)]] },
    ]);
    assert.equal(idx.locate(0.025, 0.025), 'ward');
    assert.equal(idx.locate(0.05, 0.05), 'city');
    assert.equal(idx.locate(0.5, 0.5), null);
  });

  test('a boundary spanning many grid cells is found from any of them', () => {
    const idx = new BoundaryIndex([{ key: 'big', shape: [[square(0, 0, 0.5)]] }], 0.01);
    for (const [x, y] of [
      [0.001, 0.001],
      [0.25, 0.25],
      [0.499, 0.499],
      [0.011, 0.377],
    ] as const) {
      assert.equal(idx.locate(x, y), 'big', `${x},${y}`);
    }
  });

  test('garbage in, null out', () => {
    const idx = new BoundaryIndex([{ key: 'a', shape: [[square(0, 0, 1)]] }]);
    assert.equal(idx.locate(Number.NaN, 0.5), null);
    assert.equal(idx.locate(0.5, Number.POSITIVE_INFINITY), null);
  });
});

describe('region tree', () => {
  const regions = flattenRegions();

  test('keys are unique and parents come before children', () => {
    const seen = new Set<string>();
    for (const r of regions) {
      assert.ok(!seen.has(r.key), `duplicate key ${r.key}`);
      if (r.parentKey) assert.ok(seen.has(r.parentKey), `${r.key} before its parent`);
      seen.add(r.key);
    }
  });

  test('Greater Hyderabad is a city at district depth, with its wards beneath it', () => {
    const ghmc = regions.find((r) => r.key === 'IN-TG-GHMC');
    assert.equal(ghmc?.kind, 'city');
    assert.deepEqual(ghmc?.keyPath, ['IN', 'IN-TG', 'IN-TG-GHMC']);
    const wards = regions.filter((r) => r.parentKey === 'IN-TG-GHMC');
    assert.equal(wards.length, 145);
    assert.ok(wards.every((w) => w.kind === 'ward' && w.keyPath.length === 4));
  });

  test('every ward has a boundary and every boundary is a ward', () => {
    const wardKeys = new Set(regions.filter((r) => r.kind === 'ward').map((r) => r.key));
    const boundaryKeys = new Set(wardBoundaries().map((b) => b.key));
    assert.deepEqual([...wardKeys].sort(), [...boundaryKeys].sort());
  });

  test('no invented populations: ward populations are unknown, and say so', () => {
    assert.ok(regions.filter((r) => r.kind === 'ward').every((w) => w.population === null));
  });

  test('ward names only count in a document already about their city', () => {
    const ids = syntheticIds();
    const seeds = gazetteerSeeds(ids);
    const khairatabad = seeds.find((s) => s.regionId === ids.get('IN-TG-GHMC-khairatabad'));
    assert.equal(khairatabad?.requires, ids.get('IN-TG-GHMC'));
    const telangana = seeds.find((s) => s.regionId === ids.get('IN-TG'));
    assert.equal(telangana?.requires, undefined);
    assert.ok(telangana?.names.includes('తెలంగాణ'));
  });
});

describe('resolver', () => {
  const resolver = new GeoResolver();

  // Landmarks whose ward is not in doubt. These check the real data, not just the maths.
  const landmarks: Array<[string, number, number, string]> = [
    ['Charminar', 17.3616, 78.4747, 'IN-TG-GHMC-patthergatti'],
    ['Gachibowli stadium', 17.4474, 78.3485, 'IN-TG-GHMC-gachibowli'],
    ['Jubilee Hills checkpost', 17.4295, 78.4127, 'IN-TG-GHMC-jubilee-hills'],
    ['Uppal X roads', 17.3985, 78.559, 'IN-TG-GHMC-uppal'],
    ['Khairatabad station', 17.4119, 78.4618, 'IN-TG-GHMC-khairatabad'],
    ['Ameerpet metro', 17.4375, 78.4482, 'IN-TG-GHMC-ameerpet'],
  ];
  for (const [label, lat, lng, key] of landmarks) {
    test(`${label} resolves to its ward`, () => {
      const r = resolver.resolve(lat, lng);
      assert.equal(r?.key, key);
      assert.deepEqual(r?.keyPath.slice(0, 3), ['IN', 'IN-TG', 'IN-TG-GHMC']);
    });
  }

  test('every ward contains a point that resolves to it', () => {
    // Walk each ward's bounding box for an interior point; the lookup must agree with the shape.
    let checked = 0;
    const wards = wardBoundaries();
    for (const { key, shape } of wards) {
      const outer = shape[0]?.[0] ?? [];
      const lngs = outer.map((p) => p[0]);
      const lats = outer.map((p) => p[1]);
      const [x0, x1, y0, y1] = [
        Math.min(...lngs),
        Math.max(...lngs),
        Math.min(...lats),
        Math.max(...lats),
      ];
      let found = false;
      for (let i = 1; i < 20 && !found; i++) {
        for (let j = 1; j < 20 && !found; j++) {
          const lng = x0 + ((x1 - x0) * i) / 20;
          const lat = y0 + ((y1 - y0) * j) / 20;
          // Only test points well inside (so that coarsening to ~110 m cannot move them out).
          const inside = [-0.002, 0, 0.002].every((dx) =>
            [-0.002, 0, 0.002].every((dy) =>
              pointInPolygon(shape[0] as Polygon, lng + dx, lat + dy),
            ),
          );
          if (inside) {
            assert.equal(resolver.resolve(lat, lng)?.key, key, `interior point of ${key}`);
            found = true;
            checked++;
          }
        }
      }
    }
    // A very thin ward may have no grid point 200 m from every edge; nearly all must.
    assert.ok(checked >= wards.length - 3, `only ${checked} of ${wards.length} wards checked`);
  });

  test('outside every known boundary is null, not a guess', () => {
    assert.equal(
      resolver.resolve(18.94, 72.8354),
      null,
      'Mumbai: in India, but no boundaries loaded',
    );
    assert.equal(resolver.resolve(0, 0), null);
    assert.equal(resolver.resolve(51.5, -0.12), null, 'outside India');
    assert.equal(resolver.resolve(Number.NaN, 78.4), null);
  });

  test('the answer carries a region, never the coordinate', () => {
    const r = resolver.resolve(17.411_937_2, 78.461_812_9);
    const serialised = JSON.stringify(r);
    assert.ok(!serialised.includes('17.41') && !serialised.includes('78.46'));
  });
});

describe('licensing', () => {
  test('the ward data carries its ODbL notice', () => {
    const attribution = fileURLToPath(new URL('../data/ATTRIBUTION.md', import.meta.url));
    assert.ok(existsSync(attribution));
    assert.match(readFileSync(attribution, 'utf8'), /© OpenStreetMap contributors/);
    assert.match(boundaryProvenance().license, /ODbL/);
  });
});
