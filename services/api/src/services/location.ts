import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ResolveLocationResponse } from '@civic-voice/contracts';
import { badRequest } from '@civic-voice/core';
import { GeoResolver, boundaryProvenance } from '@civic-voice/geo';
import type { Repositories } from '@civic-voice/db';
import type { RegionCache } from './regions.ts';

/**
 * "Where am I?" → a region, and a short-lived proof of it.
 *
 * The coordinate is used for one lookup and dropped. It is not logged (the route takes it in the
 * body, which is never logged, and `lat`/`lng` are on the redaction list besides), not stored, and not
 * echoed. What survives is the region the person then confirms, marked `device` if they confirm the
 * one their device resolved to — which the attestation lets the API check without trusting the
 * client's word for it, or ever seeing the coordinate again.
 */
const ATTESTATION_TTL_SECONDS = 10 * 60;
const INDIA = { minLat: 6.5, maxLat: 37.5, minLng: 68, maxLng: 97.5 };

export class LocationService {
  private readonly resolver: GeoResolver;
  private readonly repos: Repositories;
  private readonly regions: RegionCache;
  private readonly secret: string;
  private readonly now: () => number;

  constructor(opts: {
    repos: Repositories;
    regions: RegionCache;
    secret: string;
    resolver?: GeoResolver;
    now?: () => number;
  }) {
    this.repos = opts.repos;
    this.regions = opts.regions;
    this.secret = opts.secret;
    this.resolver = opts.resolver ?? new GeoResolver();
    this.now = opts.now ?? Date.now;
  }

  private sign(payload: string): string {
    // Domain-separated from access tokens, which share the secret: a location attestation can never
    // be replayed as a bearer token, or the other way round.
    return createHmac('sha256', this.secret)
      .update(`civic-location-v1:${payload}`)
      .digest('base64url');
  }

  attest(regionId: number): string {
    const payload = Buffer.from(
      JSON.stringify({ r: regionId, e: Math.floor(this.now() / 1000) + ATTESTATION_TTL_SECONDS }),
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** True when the attestation is genuine, unexpired, and for exactly this region. */
  verify(token: string, regionId: number): boolean {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    try {
      const { r, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        r: unknown;
        e: unknown;
      };
      return r === regionId && typeof e === 'number' && e * 1000 > this.now();
    } catch {
      return false;
    }
  }

  /** Resolve an attestation for `regionId`, or throw: a forged or stale one is a client bug to surface. */
  basisFor(regionId: number, token: string | undefined): 'device' | 'declared' {
    if (token === undefined) return 'declared';
    if (!this.verify(token, regionId)) {
      throw badRequest('location_attestation is invalid, expired, or for a different region');
    }
    return 'device';
  }

  async resolve(lat: number, lng: number): Promise<ResolveLocationResponse> {
    const attribution = `Ward boundaries © OpenStreetMap contributors (${boundaryProvenance().license.split(' ')[0]})`;
    const outside =
      lat < INDIA.minLat || lat > INDIA.maxLat || lng < INDIA.minLng || lng > INDIA.maxLng;
    const found = outside ? null : this.resolver.resolve(lat, lng);
    const region = found ? await this.repos.catalogue.regionByKey(found.key) : null;
    if (!region) {
      return {
        region: null,
        attestation: null,
        unresolved_reason: outside ? 'outside_india' : 'unmapped',
        attribution,
      };
    }
    const names = await this.regions.many(region.path);
    return {
      region: {
        id: region.id,
        key: found?.key ?? '',
        name: region.name,
        kind: region.kind as never,
        path: region.path,
        path_names: region.path.map((id) => names.get(id)?.name ?? ''),
      },
      attestation: this.attest(region.id),
      unresolved_reason: null,
      attribution,
    };
  }
}
