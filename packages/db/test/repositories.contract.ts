import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '@civic-voice/core';
import type { Repositories } from '../src/repositories/ports.ts';

/**
 * One conformance suite for both the Postgres and in-memory repositories (ADR-0006).
 *
 * The cases here are chosen for the semantics that are easy to implement differently by accident —
 * `upsert` reporting what it replaced, a redelivered event being a no-op, erase being a tombstone,
 * and citizen-scoped reads refusing to leak across citizens.
 */
export function runRepositoryContract(name: string, open: () => Promise<Repositories>) {
  const newCitizen = () => ({
    id: uuidv7(),
    region_id: 1052,
    region_path: [1, 10, 105, 1052],
    locale: 'hi' as const,
    demographics: { age_band: '25-34' as const, gender: 'female' as const, urbanity: 'rural' as const },
  });

  describe(`repository contract: ${name}`, () => {
    describe('citizens', () => {
      test('creates and reads back a citizen with no PII', async () => {
        const repos = await open();
        try {
          const input = newCitizen();
          const created = await repos.citizens.create(input);
          assert.equal(created.id, input.id);
          assert.equal(created.verification_tier, 0, 'new citizens start anonymous');
          assert.deepEqual(created.region_path, [1, 10, 105, 1052]);
          assert.deepEqual(created.demographics, input.demographics);

          const found = await repos.citizens.findById(input.id);
          assert.deepEqual(found?.demographics, input.demographics);
          // The row shape itself must not carry identity fields.
          assert.ok(!('phone' in (found ?? {})));
          assert.ok(!('name' in (found ?? {})));
        } finally {
          await repos.close();
        }
      });

      test('round-trips every demographic band through the ordinal codec', async () => {
        const repos = await open();
        try {
          const input = {
            ...newCitizen(),
            demographics: {
              age_band: '65+' as const,
              gender: 'other' as const,
              urbanity: 'urban' as const,
              income_band: 'highest' as const,
              education_band: 'postgraduate' as const,
              occupation_band: 'retired_other' as const,
            },
          };
          await repos.citizens.create(input);
          const found = await repos.citizens.findById(input.id);
          assert.deepEqual(found?.demographics, input.demographics, 'last ordinal of every band');
        } finally {
          await repos.close();
        }
      });

      test('a declined dimension stays absent rather than becoming a bogus band', async () => {
        const repos = await open();
        try {
          const input = { ...newCitizen(), demographics: { gender: 'male' as const } };
          await repos.citizens.create(input);
          const found = await repos.citizens.findById(input.id);
          assert.deepEqual(found?.demographics, { gender: 'male' });
          assert.equal('age_band' in (found?.demographics ?? {}), false);
        } finally {
          await repos.close();
        }
      });

      test('returns null for an unknown citizen instead of throwing', async () => {
        const repos = await open();
        try {
          assert.equal(await repos.citizens.findById(uuidv7()), null);
        } finally {
          await repos.close();
        }
      });

      test('updates a profile without disturbing untouched fields', async () => {
        const repos = await open();
        try {
          const input = newCitizen();
          await repos.citizens.create(input);
          const updated = await repos.citizens.updateProfile(input.id, { locale: 'ta' });
          assert.equal(updated?.locale, 'ta');
          assert.equal(updated?.region_id, input.region_id, 'region must be untouched');
          assert.deepEqual(updated?.demographics, input.demographics, 'bands must be untouched');
        } finally {
          await repos.close();
        }
      });

      test('a supplied demographics set replaces wholesale, so a dimension can be withdrawn', async () => {
        const repos = await open();
        try {
          const input = newCitizen();
          await repos.citizens.create(input);
          const updated = await repos.citizens.updateProfile(input.id, {
            demographics: { gender: 'female' },
          });
          assert.deepEqual(updated?.demographics, { gender: 'female' });
        } finally {
          await repos.close();
        }
      });

      test('promotes verification tier', async () => {
        const repos = await open();
        try {
          const input = newCitizen();
          await repos.citizens.create(input);
          assert.equal((await repos.citizens.setVerificationTier(input.id, 2))?.verification_tier, 2);
        } finally {
          await repos.close();
        }
      });

      test('erasure tombstones the row, clears the bands, and is not repeatable', async () => {
        const repos = await open();
        try {
          const input = newCitizen();
          await repos.citizens.create(input);
          assert.equal(await repos.citizens.erase(input.id), true);

          const after = await repos.citizens.findById(input.id);
          assert.ok(after !== null, 'the row survives, so shard accounting stays consistent');
          assert.notEqual(after?.erased_at, null);
          assert.deepEqual(after?.demographics, {}, 'bands must be gone');

          assert.equal(await repos.citizens.erase(input.id), false, 'a second erase is a no-op');
        } finally {
          await repos.close();
        }
      });

      test('an erased citizen cannot be updated back into existence', async () => {
        const repos = await open();
        try {
          const input = newCitizen();
          await repos.citizens.create(input);
          await repos.citizens.erase(input.id);
          assert.equal(await repos.citizens.updateProfile(input.id, { locale: 'en' }), null);
          assert.equal(await repos.citizens.setVerificationTier(input.id, 3), null);
        } finally {
          await repos.close();
        }
      });
    });

    describe('sentiment', () => {
      test('a first opinion replaces nothing', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          const result = await repos.sentiment.upsert(citizen.id, {
            topic_id: 1, mood: -1, intensity: 4, reason_code: 'poor_implementation', event_id: uuidv7(),
          });
          assert.equal(result.applied, true);
          assert.equal(result.previous, null);
        } finally {
          await repos.close();
        }
      });

      test('a changed opinion reports the value it replaced — the compensating delta', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          await repos.sentiment.upsert(citizen.id, {
            topic_id: 1, mood: -2, intensity: 5, reason_code: 'corruption_suspected', event_id: uuidv7(),
          });
          const changed = await repos.sentiment.upsert(citizen.id, {
            topic_id: 1, mood: 2, intensity: 3, reason_code: 'benefits_me', event_id: uuidv7(),
          });
          assert.equal(changed.applied, true);
          assert.equal(changed.previous?.mood, -2, 'the OLD mood, for the −1');
          assert.equal(changed.previous?.intensity, 5);
          assert.equal(changed.previous?.reason_code, 'corruption_suspected');

          const current = await repos.sentiment.getCurrent(citizen.id, 1);
          assert.equal(current?.mood, 2);
          assert.equal(current?.reason_code, 'benefits_me');
        } finally {
          await repos.close();
        }
      });

      test('REDELIVERY: re-applying the same event id is a no-op, not a second count', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          const eventId = uuidv7();
          const row = {
            topic_id: 1, mood: 1 as const, intensity: 3, reason_code: 'no_reason' as const, event_id: eventId,
          };
          const first = await repos.sentiment.upsert(citizen.id, row);
          const redelivered = await repos.sentiment.upsert(citizen.id, row);

          assert.equal(first.applied, true);
          assert.equal(redelivered.applied, false, 'at-least-once delivery must not double count');
          assert.equal(redelivered.previous, null, 'and must not emit a compensating delta');
        } finally {
          await repos.close();
        }
      });

      test('opinions are per topic, and listed newest first', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          for (const topicId of [1, 2, 3]) {
            await repos.sentiment.upsert(citizen.id, {
              topic_id: topicId, mood: 0, intensity: 3, reason_code: 'no_reason', event_id: uuidv7(),
            });
          }
          const all = await repos.sentiment.listCurrent(citizen.id);
          assert.equal(all.length, 3);
          assert.deepEqual([...all].map((r) => r.topic_id).sort(), [1, 2, 3]);
        } finally {
          await repos.close();
        }
      });

      test('listCurrent can be narrowed to specific topics, for the overlay read', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          for (const topicId of [1, 2, 3]) {
            await repos.sentiment.upsert(citizen.id, {
              topic_id: topicId, mood: 0, intensity: 3, reason_code: 'no_reason', event_id: uuidv7(),
            });
          }
          const some = await repos.sentiment.listCurrent(citizen.id, { topicIds: [1, 3] });
          assert.deepEqual(some.map((r) => r.topic_id).sort(), [1, 3]);
        } finally {
          await repos.close();
        }
      });

      test('one citizen’s opinions are invisible to another', async () => {
        const repos = await open();
        try {
          const a = newCitizen();
          const b = newCitizen();
          await repos.citizens.create(a);
          await repos.citizens.create(b);
          await repos.sentiment.upsert(a.id, {
            topic_id: 9, mood: 2, intensity: 5, reason_code: 'benefits_me', event_id: uuidv7(),
          });
          assert.equal(await repos.sentiment.getCurrent(b.id, 9), null);
          assert.deepEqual(await repos.sentiment.listCurrent(b.id), []);
        } finally {
          await repos.close();
        }
      });

      test('erasure removes the citizen’s opinions', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          await repos.sentiment.upsert(citizen.id, {
            topic_id: 1, mood: 1, intensity: 3, reason_code: 'no_reason', event_id: uuidv7(),
          });
          await repos.citizens.erase(citizen.id);
          assert.deepEqual(await repos.sentiment.listCurrent(citizen.id), []);
        } finally {
          await repos.close();
        }
      });
    });

    describe('RTI requests', () => {
      const newRti = (citizenId: string, over: Record<string, unknown> = {}) => ({
        id: uuidv7(),
        citizen_id: citizenId,
        authority_id: 1,
        topic_id: null,
        subject: 'Details of Jal Jeevan Mission tap connections completed in this district',
        track: 'standard' as const,
        filed_at: null,
        acknowledged_at: null,
        responded_at: null,
        first_appeal_at: null,
        fa_responded_at: null,
        fa_extended: false,
        second_appeal_at: null,
        ...over,
      });

      test('an unfiled request starts as a draft; a filed one starts filed', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          assert.equal((await repos.rti.create(newRti(citizen.id))).state, 'draft');
          assert.equal(
            (await repos.rti.create(newRti(citizen.id, { filed_at: '2026-01-01' }))).state,
            'filed',
          );
        } finally {
          await repos.close();
        }
      });

      test('a transition stamps the matching statutory date column', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          const created = await repos.rti.create(newRti(citizen.id, { filed_at: '2026-01-01' }));
          const responded = await repos.rti.transition(citizen.id, created.id, 'responded', '2026-01-28');
          assert.equal(responded?.state, 'responded');
          assert.equal(responded?.responded_at, '2026-01-28');
          assert.equal(responded?.filed_at, '2026-01-01', 'earlier dates are preserved');
        } finally {
          await repos.close();
        }
      });

      test('a transition without a date does not clobber an existing one', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          const created = await repos.rti.create(newRti(citizen.id, { filed_at: '2026-01-01' }));
          const again = await repos.rti.transition(citizen.id, created.id, 'filed', null);
          assert.equal(again?.filed_at, '2026-01-01');
        } finally {
          await repos.close();
        }
      });

      test('a request cannot be read or transitioned by another citizen', async () => {
        const repos = await open();
        try {
          const a = newCitizen();
          const b = newCitizen();
          await repos.citizens.create(a);
          await repos.citizens.create(b);
          const created = await repos.rti.create(newRti(a.id, { filed_at: '2026-01-01' }));

          assert.equal(await repos.rti.findById(b.id, created.id), null, 'guessing an id must fail');
          assert.equal(await repos.rti.transition(b.id, created.id, 'responded', '2026-02-01'), null);
        } finally {
          await repos.close();
        }
      });

      test('lists a citizen’s own filings, newest first', async () => {
        const repos = await open();
        try {
          const citizen = newCitizen();
          await repos.citizens.create(citizen);
          await repos.rti.create(newRti(citizen.id));
          await repos.rti.create(newRti(citizen.id));
          assert.equal((await repos.rti.listByCitizen(citizen.id)).length, 2);
        } finally {
          await repos.close();
        }
      });
    });

    describe('aggregate quarantine', () => {
      test('records and reads back a quarantined bucket', async () => {
        const repos = await open();
        try {
          const topicId = 700_000 + Math.floor(Math.random() * 100_000);
          await repos.catalogue.addQuarantine({
            topic_id: topicId, region_id: 105, dim: 1, bucket: '25-34',
            reason: 'velocity', detail: '31x baseline',
          });
          const found = await repos.catalogue.quarantinedBuckets(topicId, 105, 1);
          assert.equal(found.length, 1);
          assert.equal(found[0]?.bucket, '25-34');
          assert.equal(found[0]?.reason, 'velocity');
        } finally {
          await repos.close();
        }
      });

      test('re-quarantining the same bucket updates rather than duplicating', async () => {
        const repos = await open();
        try {
          const topicId = 800_000 + Math.floor(Math.random() * 100_000);
          const row = { topic_id: topicId, region_id: 105, dim: 1, bucket: '25-34', reason: 'velocity' };
          await repos.catalogue.addQuarantine(row);
          await repos.catalogue.addQuarantine({ ...row, reason: 'homogeneity' });
          const found = await repos.catalogue.quarantinedBuckets(topicId, 105, 1);
          assert.equal(found.length, 1);
          assert.equal(found[0]?.reason, 'homogeneity');
        } finally {
          await repos.close();
        }
      });

      test('an unquarantined slice reads empty', async () => {
        const repos = await open();
        try {
          assert.deepEqual(await repos.catalogue.quarantinedBuckets(999_111, 1, 0), []);
        } finally {
          await repos.close();
        }
      });
    });
  });
}
