import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  blindIndex,
  constantTimeEqualHex,
  derivePseudonym,
  normaliseIndianMobile,
} from '../src/pseudonym.ts';
import { uuidv7, uuidv7Timestamp } from '../src/ids.ts';
import { addDays, dayNumber, daysBetween, dayOf, fromDayNumber } from '../src/time.ts';

const saltA = randomBytes(32);
const saltB = randomBytes(32);

describe('per-topic pseudonyms', () => {
  test('stable within a topic, so one citizen is one voice', () => {
    const a = derivePseudonym(saltA, 'citizen-1');
    assert.equal(a, derivePseudonym(saltA, 'citizen-1'));
  });

  test('unlinkable across topics without the other topic’s salt', () => {
    assert.notEqual(derivePseudonym(saltA, 'citizen-1'), derivePseudonym(saltB, 'citizen-1'));
  });

  test('distinct citizens do not collide within a topic', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(derivePseudonym(saltA, `citizen-${i}`));
    assert.equal(seen.size, 20_000);
  });

  test('is 128 bits, matching the wire schema', () => {
    assert.equal(derivePseudonym(saltA, 'citizen-1').length, 32);
  });

  test('refuses a weak salt rather than producing a weak pseudonym', () => {
    assert.throws(() => derivePseudonym('short', 'citizen-1'), RangeError);
  });
});

describe('identity blind indexing', () => {
  test('the same identity always yields the same index, so it can claim only one account', () => {
    const pepper = randomBytes(32);
    assert.equal(blindIndex(pepper, '9876543210'), blindIndex(pepper, '9876543210'));
  });

  test('rotating the pepper changes every index, which is what re-blinding means', () => {
    assert.notEqual(
      blindIndex(randomBytes(32), '9876543210'),
      blindIndex(randomBytes(32), '9876543210'),
    );
  });

  test('refuses a pepper too short to be worth anything', () => {
    assert.throws(() => blindIndex(randomBytes(16), '9876543210'), RangeError);
  });

  test('normalisation collapses the ways one number can be written', () => {
    const forms = [
      '9876543210',
      '+91 98765 43210',
      '09876543210',
      '91-9876543210',
      '(98765) 43210',
    ];
    const normalised = new Set(forms.map(normaliseIndianMobile));
    assert.equal(normalised.size, 1, `all forms must normalise alike, got ${[...normalised]}`);
    assert.equal([...normalised][0], '9876543210');
  });

  test('rejects numbers that are not valid Indian mobiles', () => {
    for (const bad of ['1234567890', '5876543210', '98765', '98765432101234']) {
      assert.throws(() => normaliseIndianMobile(bad), RangeError, `should reject ${bad}`);
    }
  });

  test('hex comparison is length-safe and rejects malformed input', () => {
    const a = blindIndex(randomBytes(32), 'x');
    const b = blindIndex(randomBytes(32), 'y');
    assert.equal(constantTimeEqualHex(a, a), true);
    assert.equal(constantTimeEqualHex(a, b), false);
    assert.equal(constantTimeEqualHex(a, a.slice(0, 10)), false);
    // Non-hex input must not compare equal just because it decodes to nothing.
    assert.equal(constantTimeEqualHex('zz', 'zz'), false);
    assert.equal(constantTimeEqualHex('zz', 'yy'), false);
    assert.equal(constantTimeEqualHex('', ''), false);
    assert.equal(constantTimeEqualHex('abc', 'abd'), false, 'odd length is not valid hex');
  });
});

describe('uuidv7', () => {
  test('is time-ordered, which is what keeps index inserts append-mostly', () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) ids.push(uuidv7(1_700_000_000_000 + i * 10));
    assert.deepEqual(ids, [...ids].sort());
  });

  test('encodes its millisecond, recoverable without a timestamp column', () => {
    const now = 1_774_000_000_000;
    assert.equal(uuidv7Timestamp(uuidv7(now)), now);
  });

  test('sets the version and variant bits', () => {
    const id = uuidv7();
    assert.equal(id[14], '7', 'version nibble');
    assert.ok(['8', '9', 'a', 'b'].includes(id[19] as string), 'RFC 4122 variant');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('does not collide within a millisecond', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i += 1) seen.add(uuidv7(1_700_000_000_000));
    assert.equal(seen.size, 50_000);
  });
});

describe('day arithmetic', () => {
  test('round-trips dates', () => {
    for (const d of ['2026-01-01', '2026-02-28', '2026-12-31', '2024-02-29']) {
      assert.equal(fromDayNumber(dayNumber(d)), d);
    }
  });

  test('crosses month and year boundaries and leap days correctly', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29', 'leap year');
    assert.equal(addDays('2026-02-28', 1), '2026-03-01', 'non-leap year');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });

  test('a 30-day statutory window lands where a lawyer would say it does', () => {
    assert.equal(addDays('2026-01-01', 30), '2026-01-31');
    assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
  });

  test('rejects a date that is not a real calendar day', () => {
    // Date.UTC would silently roll this into March, which in a legal deadline is unacceptable.
    assert.throws(() => dayNumber('2026-02-30'), RangeError);
    assert.throws(() => dayNumber('2026-13-01'), RangeError);
    assert.throws(() => dayNumber('26-01-01'), RangeError);
    assert.throws(() => dayNumber('2026-1-1'), RangeError);
  });

  test('the rollup day bucket is UTC, so it does not shift with the server’s timezone', () => {
    assert.equal(dayOf('2026-03-15T23:59:59.999Z'), '2026-03-15');
    assert.equal(dayOf('2026-03-16T00:00:00.000Z'), '2026-03-16');
  });
});
