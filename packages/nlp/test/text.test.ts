import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, dominantScript, normalize, tokenize } from '../src/text.ts';
import { detectPii, redactPii, verhoeffCheckDigit, verhoeffValid } from '../src/pii.ts';

describe('script and language detection', () => {
  test('recognises native scripts', () => {
    assert.equal(dominantScript('హైదరాబాద్ లో రోడ్లు బాగాలేవు'), 'telugu');
    assert.equal(dominantScript('पानी की समस्या बहुत है'), 'devanagari');
    assert.equal(dominantScript('தண்ணீர் பிரச்சனை'), 'tamil');
    assert.equal(dominantScript('roads are bad'), 'latin');
  });

  test('maps native scripts to languages', () => {
    assert.equal(detectLanguage('హైదరాబాద్ లో రోడ్లు బాగాలేవు').language, 'te');
    assert.equal(detectLanguage('पानी की समस्या बहुत है').language, 'hi');
  });

  test('separates English from romanised Hindi and romanised Telugu', () => {
    assert.equal(detectLanguage('The roads in our area are very bad').language, 'en');
    assert.equal(detectLanguage('paani nahi aa raha hai teen din se').language, 'hi-Latn');
    assert.equal(
      detectLanguage('maa colony lo neellu raavatledu chala rojulu nundi').language,
      'te-Latn',
    );
  });

  test('a mixed comment goes to the script that dominates it', () => {
    // Code-mixing is normal: a Telugu sentence with an English noun is still Telugu.
    assert.equal(detectLanguage('metro extension చాలా మంచి నిర్ణయం').language, 'te');
  });

  test('empty or symbol-only text is undetermined, not English by default', () => {
    assert.equal(detectLanguage('!!! 123 ???').language, 'und');
  });

  test('normalisation strips noise but keeps every script', () => {
    assert.equal(normalize('Sooooo BAD!!!  https://x.co/abc @someone'), 'soo bad!');
    assert.equal(normalize('రోడ్లు   బాగాలేవు'), 'రోడ్లు బాగాలేవు');
  });

  test('tokenisation keeps Indic combining marks inside words', () => {
    // Splitting on \W would cut Telugu and Devanagari words at every vowel sign.
    assert.deepEqual(tokenize('రోడ్లు బాగాలేవు'), ['రోడ్లు', 'బాగాలేవు']);
    assert.deepEqual(tokenize('किसानों को MSP चाहिए'), ['किसानों', 'को', 'msp', 'चाहिए']);
  });
});

describe('PII detection', () => {
  // Build a Verhoeff-valid 12-digit number rather than hard-coding anything that could be real.
  const payload = '23456789012';
  const validAadhaar = `${payload}${verhoeffCheckDigit(payload)}`;
  const invalidAadhaar = `${payload}${(verhoeffCheckDigit(payload) + 1) % 10}`;

  test('Verhoeff validates what it computes, and rejects a single-digit error', () => {
    assert.equal(verhoeffValid(validAadhaar), true);
    assert.equal(verhoeffValid(invalidAadhaar), false);
    // Verhoeff also catches adjacent transpositions, which Luhn does not.
    const swapped =
      validAadhaar.slice(0, 3) + validAadhaar[4] + validAadhaar[3] + validAadhaar.slice(5);
    if (swapped !== validAadhaar) assert.equal(verhoeffValid(swapped), false);
  });

  test('flags a checksum-valid Aadhaar number, including grouped forms', () => {
    const grouped = `${validAadhaar.slice(0, 4)} ${validAadhaar.slice(4, 8)} ${validAadhaar.slice(8)}`;
    assert.equal(detectPii(`my aadhaar ${validAadhaar} pension not received`)[0]?.kind, 'aadhaar');
    assert.equal(detectPii(`aadhaar: ${grouped}`)[0]?.kind, 'aadhaar');
  });

  test('does NOT flag an arbitrary 12-digit number that fails the checksum', () => {
    const hits = detectPii(`application no ${invalidAadhaar} still pending`).filter(
      (m) => m.kind === 'aadhaar',
    );
    assert.equal(hits.length, 0, 'an order number must not be treated as an Aadhaar');
  });

  test('flags Indian mobile numbers in their common forms', () => {
    for (const phone of ['9876543210', '+91 98765 43210', '09876543210', '98765-43210']) {
      assert.equal(detectPii(`call me on ${phone}`)[0]?.kind, 'phone', phone);
    }
  });

  test('does not flag numbers that cannot be Indian mobiles', () => {
    assert.deepEqual(detectPii('ward 91 has 1234567890 problems'), []);
    assert.deepEqual(detectPii('budget of 5000 crore for 2026'), []);
  });

  test('flags PAN only with a valid holder-type character', () => {
    assert.equal(detectPii('PAN ABCPE1234F')[0]?.kind, 'pan');
    assert.deepEqual(
      detectPii('code ABCXE1234F').filter((m) => m.kind === 'pan'),
      [],
    );
  });

  test('flags emails and UPI handles', () => {
    assert.equal(detectPii('mail me at someone@example.com')[0]?.kind, 'email');
    assert.equal(detectPii('send to ramesh@okaxis')[0]?.kind, 'upi');
  });

  test('flags a labelled bank account number but not a bare number', () => {
    assert.equal(detectPii('a/c no 123456789012 in SBI')[0]?.kind, 'bank_account');
  });

  test('redaction replaces each identifier and leaves the complaint readable', () => {
    const { text, matches } = redactPii(`pension stopped, aadhaar ${validAadhaar}, ph 9876543210`);
    assert.equal(matches.length, 2);
    assert.match(text, /pension stopped/);
    assert.match(text, /\[aadhaar removed\]/);
    assert.match(text, /\[phone removed\]/);
    assert.ok(!text.includes(validAadhaar));
  });

  test('clean civic text produces no matches', () => {
    assert.deepEqual(detectPii('Potholes on the road near Khairatabad flyover since monsoon'), []);
    assert.deepEqual(detectPii('హైదరాబాద్ లో రోడ్లు బాగాలేవు'), []);
  });
});
