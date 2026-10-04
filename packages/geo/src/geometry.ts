/**
 * Plane geometry on longitude/latitude, enough to answer "which ward is this point in".
 *
 * Planar maths on degrees is wrong at continental scale and exact enough at city scale: across a
 * ward (a few kilometres) the distortion from treating degrees as a plane is far below the accuracy
 * of the boundaries themselves (OSM ward lines are traced to tens of metres) and of a phone's fix.
 * Nothing here computes distances or areas that are reported to anyone.
 */

/** [longitude, latitude] — GeoJSON order. */
export type Position = readonly [number, number];
/** A closed ring: first position equals last. */
export type Ring = readonly Position[];
/** Outer ring first, then holes. */
export type Polygon = readonly Ring[];
export type MultiPolygon = readonly Polygon[];

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export function bboxOf(shape: MultiPolygon): BBox {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const polygon of shape) {
    // Holes lie inside the outer ring, so the outer ring alone bounds the polygon.
    for (const [lng, lat] of polygon[0] ?? []) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLng, minLat, maxLng, maxLat };
}

export function inBBox(box: BBox, lng: number, lat: number): boolean {
  return lng >= box.minLng && lng <= box.maxLng && lat >= box.minLat && lat <= box.maxLat;
}

/**
 * Even-odd ray casting. A point exactly on an edge may land either side; for ward lookup that is
 * harmless (the neighbouring ward is an equally true answer for a point on the boundary road).
 */
export function pointInRing(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Position;
    const [xj, yj] = ring[j] as Position;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(polygon: Polygon, lng: number, lat: number): boolean {
  const [outer, ...holes] = polygon;
  if (!outer || !pointInRing(outer, lng, lat)) return false;
  return !holes.some((hole) => pointInRing(hole, lng, lat));
}

export function pointInShape(shape: MultiPolygon, lng: number, lat: number): boolean {
  return shape.some((polygon) => pointInPolygon(polygon, lng, lat));
}

/** Shoelace area in square degrees; used only to order and sanity-check shapes, never reported. */
export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Position;
    const [xj, yj] = ring[j] as Position;
    sum += (xj - xi) * (yj + yi);
  }
  return Math.abs(sum) / 2;
}

function perpendicularDistance(p: Position, a: Position, b: Position): number {
  const [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/**
 * Douglas–Peucker, iterative (a ring with tens of thousands of points must not blow the stack).
 * `tolerance` is in degrees; 0.0001° is about 11 m in Hyderabad — below the accuracy of the source
 * lines, so simplifying at that tolerance loses nothing that was true.
 */
export function simplifyRing(ring: Ring, tolerance: number): Position[] {
  if (ring.length <= 4) return ring.map((p) => [p[0], p[1]] as const);
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let worst = -1;
    let worstDistance = 0;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(
        ring[i] as Position,
        ring[start] as Position,
        ring[end] as Position,
      );
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst >= 0 && worstDistance > tolerance) {
      keep[worst] = 1;
      stack.push([start, worst], [worst, end]);
    }
  }
  const out = ring.filter((_, i) => keep[i] === 1).map((p) => [p[0], p[1]] as const);
  // A closed ring's first and last points coincide, so the endpoints alone would collapse it.
  // Keep at least a triangle: fall back to the original if simplification went below that.
  return out.length >= 4 ? out : ring.map((p) => [p[0], p[1]] as const);
}

export function simplifyShape(shape: MultiPolygon, tolerance: number): Position[][][] {
  return shape.map((polygon) => polygon.map((ring) => simplifyRing(ring, tolerance)));
}

/** Round to `decimals` places. 3 decimals is ~110 m: enough for a ward, not enough for a house. */
export function coarsen(value: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
