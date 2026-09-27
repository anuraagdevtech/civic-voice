import type { RegionRow, Repositories } from '@civic-voice/db';

/**
 * Region rows by id, cached in-process. Names and paths are read on nearly every forum and document
 * response ("from Khairatabad", "Greater Hyderabad · Telangana") and change on the order of years; a
 * short TTL keeps the catalogue out of the hot path while still picking up a rename within minutes.
 */
export class RegionCache {
  private readonly repos: Repositories;
  private readonly ttlMs: number;
  private readonly rows = new Map<number, { row: RegionRow | null; at: number }>();

  constructor(repos: Repositories, ttlMs = 10 * 60 * 1000) {
    this.repos = repos;
    this.ttlMs = ttlMs;
  }

  async many(ids: readonly number[]): Promise<Map<number, RegionRow>> {
    const now = Date.now();
    const missing = [...new Set(ids)].filter((id) => {
      const hit = this.rows.get(id);
      return !hit || now - hit.at > this.ttlMs;
    });
    if (missing.length > 0) {
      const fetched = await this.repos.catalogue.getRegions(missing);
      const byId = new Map(fetched.map((r) => [r.id, r]));
      if (this.rows.size > 100_000) this.rows.clear();
      for (const id of missing) this.rows.set(id, { row: byId.get(id) ?? null, at: now });
    }
    const out = new Map<number, RegionRow>();
    for (const id of ids) {
      const row = this.rows.get(id)?.row;
      if (row) out.set(id, row);
    }
    return out;
  }

  async one(id: number): Promise<RegionRow | null> {
    return (await this.many([id])).get(id) ?? null;
  }

  async name(id: number | null): Promise<string | null> {
    return id === null ? null : ((await this.one(id))?.name ?? null);
  }
}
