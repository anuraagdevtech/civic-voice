import { flattenRegions, GEOGRAPHY, type SeedRegion } from '@civic-voice/geo';
import type { MemoryCatalogueRepository } from './repositories/memory.ts';

/**
 * Load the canonical region tree into an in-memory catalogue, with ids assigned in insertion order
 * exactly as the Postgres seed assigns them. For tests and the no-infrastructure dev stack.
 */
export function seedMemoryGeography(
  catalogue: MemoryCatalogueRepository,
  root: SeedRegion = GEOGRAPHY,
): Map<string, number> {
  const idByKey = new Map<string, number>();
  let next = Math.max(0, ...catalogue.regions.keys()) + 1;
  for (const r of flattenRegions(root)) {
    const id = next++;
    idByKey.set(r.key, id);
    const path = r.keyPath.map((k) => idByKey.get(k) as number);
    catalogue.putRegion({
      id,
      parent_id: r.parentKey ? (idByKey.get(r.parentKey) ?? null) : null,
      kind: r.kind,
      path,
      name: r.name,
      names: r.names ?? {},
      population: r.population,
      codes: { ...r.codes, key: r.key },
    });
  }
  return idByKey;
}
