import {
  bboxOf,
  inBBox,
  pointInShape,
  ringArea,
  type BBox,
  type MultiPolygon,
} from './geometry.ts';

export interface Boundary {
  /** Stable region key (see regions.ts), not a database id. */
  key: string;
  shape: MultiPolygon;
}

interface Indexed extends Boundary {
  bbox: BBox;
  area: number;
}

/**
 * Point → boundary lookup over a uniform grid.
 *
 * Each boundary is registered in every grid cell its bounding box touches; a lookup tests only the
 * few boundaries registered in the point's cell, first by bounding box and then exactly. With cells
 * of ~1 km and wards of a few km, a cell holds a handful of candidates, so a lookup is a few dozen
 * point-in-ring edge tests: microseconds, and entirely in memory — resolving a location never
 * touches a database, which is what lets it sit on the request path of every API pod.
 *
 * Overlapping boundaries (a data error, or nested shapes) resolve to the smallest, which is the most
 * specific answer the data supports.
 */
export class BoundaryIndex {
  private readonly cells = new Map<string, Indexed[]>();
  private readonly cellSize: number;
  private count = 0;

  constructor(boundaries: readonly Boundary[] = [], cellSizeDegrees = 0.01) {
    this.cellSize = cellSizeDegrees;
    for (const b of boundaries) this.add(b);
  }

  get size(): number {
    return this.count;
  }

  private cellKey(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  add(boundary: Boundary): void {
    const bbox = bboxOf(boundary.shape);
    if (!Number.isFinite(bbox.minLng))
      throw new RangeError(`boundary ${boundary.key} has no coordinates`);
    const area = boundary.shape.reduce((sum, polygon) => sum + ringArea(polygon[0] ?? []), 0);
    const entry: Indexed = { ...boundary, bbox, area };
    const x0 = Math.floor(bbox.minLng / this.cellSize);
    const x1 = Math.floor(bbox.maxLng / this.cellSize);
    const y0 = Math.floor(bbox.minLat / this.cellSize);
    const y1 = Math.floor(bbox.maxLat / this.cellSize);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = this.cellKey(cx, cy);
        const list = this.cells.get(key);
        if (list) list.push(entry);
        else this.cells.set(key, [entry]);
      }
    }
    this.count++;
  }

  /** The key of the (smallest) boundary containing the point, or null if none does. */
  locate(lng: number, lat: number): string | null {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const candidates = this.cells.get(
      this.cellKey(Math.floor(lng / this.cellSize), Math.floor(lat / this.cellSize)),
    );
    if (!candidates) return null;
    let best: Indexed | null = null;
    for (const c of candidates) {
      if (!inBBox(c.bbox, lng, lat)) continue;
      if (best && c.area >= best.area) continue;
      if (pointInShape(c.shape, lng, lat)) best = c;
    }
    return best?.key ?? null;
  }
}
