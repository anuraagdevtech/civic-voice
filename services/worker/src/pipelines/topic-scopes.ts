import type { Repositories } from '@civic-voice/db';

/**
 * Topic → jurisdiction path and title, cached. Trending needs a topic's jurisdiction path on every
 * batch; topics change on the order of months, so a short TTL keeps this off the catalogue entirely
 * in steady state while still noticing a re-scoped topic within minutes.
 */
export interface TopicScope {
  title: string;
  jurisdictionPath: number[];
}

export class TopicScopes {
  private readonly repos: Repositories;
  private readonly ttlMs: number;
  private readonly cache = new Map<number, { scope: TopicScope | null; at: number }>();

  constructor(repos: Repositories, ttlMs = 5 * 60 * 1000) {
    this.repos = repos;
    this.ttlMs = ttlMs;
  }

  async get(topicId: number): Promise<TopicScope | null> {
    const hit = this.cache.get(topicId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.scope;
    const topic = await this.repos.catalogue.getTopic(topicId);
    const region = topic
      ? await this.repos.catalogue.getRegion(topic.jurisdiction_region_id)
      : null;
    const scope = topic && region ? { title: topic.title, jurisdictionPath: region.path } : null;
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(topicId, { scope, at: Date.now() });
    return scope;
  }
}
