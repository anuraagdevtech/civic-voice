import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Gazetteer } from '../src/gazetteer.ts';

// A small hierarchy: India(1) > Telangana(10) > Greater Hyderabad(100) > Khairatabad ward(1001)
//                     India(1) > Andhra Pradesh(20) > Krishna(200)
//                     Two different "Aurangabad"s, to test ambiguity.
const g = new Gazetteer([
  { regionId: 1, path: [1], names: ['India', 'भारत', 'భారత'] },
  { regionId: 10, path: [1, 10], names: ['Telangana', 'తెలంగాణ', 'तेलंगाना'] },
  {
    regionId: 100,
    path: [1, 10, 100],
    names: ['Greater Hyderabad', 'Hyderabad', 'GHMC', 'హైదరాబాద్', 'हैदराबाद'],
  },
  { regionId: 1001, path: [1, 10, 100, 1001], names: ['Khairatabad', 'ఖైరతాబాద్'] },
  { regionId: 1003, path: [1, 10, 100, 1003], names: ['Secunderabad'] },
  { regionId: 20, path: [1, 20], names: ['Andhra Pradesh', 'ఆంధ్రప్రదేశ్'] },
  { regionId: 200, path: [1, 20, 200], names: ['Krishna'] },
  { regionId: 300, path: [1, 30, 300], names: ['Aurangabad'] },
  { regionId: 400, path: [1, 40, 400], names: ['Aurangabad'] },
]);

describe('gazetteer', () => {
  test('tags the most specific place first', () => {
    const tags = g.tag({
      title: 'Storm water drains in Khairatabad, Hyderabad',
      jurisdictionPath: [1, 10],
    });
    assert.deepEqual(
      tags.map((t) => t.regionId),
      [1001, 100],
    );
  });

  test('matches Telugu and Hindi names', () => {
    assert.equal(g.tag({ title: 'హైదరాబాద్ లో మెట్రో విస్తరణ' })[0]?.regionId, 100);
    assert.equal(g.tag({ title: 'हैदराबाद मेट्रो' })[0]?.regionId, 100);
  });

  test('a shorter name inside a longer match is one mention, not two', () => {
    const tags = g.tag({ title: 'Greater Hyderabad Municipal Corporation budget' });
    assert.equal(tags.length, 1);
    assert.equal(tags[0]?.matched, 'greater hyderabad');
  });

  test('does not match a name inside another word', () => {
    // "India" inside "Indiana", "Krishna" inside "Krishnappa" — word boundaries matter.
    assert.deepEqual(g.tag({ title: 'Indiana Krishnappa visited' }), []);
  });

  test('an ambiguous name is dropped when the jurisdiction cannot settle it', () => {
    assert.deepEqual(g.tag({ title: 'Aurangabad water supply' }), []);
  });

  test('the jurisdiction resolves an otherwise ambiguous name', () => {
    const tags = g.tag({ title: 'Aurangabad water supply', jurisdictionPath: [1, 30] });
    assert.equal(tags[0]?.regionId, 300);
  });

  test('a title mention is more confident than a body mention', () => {
    const [inTitle] = g.tag({ title: 'Khairatabad flyover' });
    const [inBody] = g.tag({ title: 'Flyover works', body: 'at Khairatabad junction' });
    assert.ok((inTitle?.confidence ?? 0) > (inBody?.confidence ?? 0));
  });

  test('the primary region stays inside the issuing jurisdiction', () => {
    // A Telangana GO that mentions Krishna (AP) in passing is still about Telangana, not Krishna.
    const tags = g.tag({ title: 'Water sharing with Krishna district', jurisdictionPath: [1, 10] });
    const primary = g.primaryRegion(tags, [1, 10]);
    assert.equal(primary?.regionId, 10);
  });

  test('the primary region narrows to the most specific place inside the jurisdiction', () => {
    const tags = g.tag({ title: 'Sanction for Khairatabad drains', jurisdictionPath: [1, 10] });
    assert.equal(g.primaryRegion(tags, [1, 10])?.regionId, 1001);
  });

  test('several places in one title are scoped to what they have in common', () => {
    const tags = g.tag({
      title: 'Drains in Khairatabad and Secunderabad',
      jurisdictionPath: [1, 10],
    });
    assert.equal(g.primaryRegion(tags, [1, 10])?.regionId, 100);
  });

  test('a place named with its own parent is still the specific place', () => {
    const tags = g.tag({
      title: 'Drains in Khairatabad, Greater Hyderabad',
      jurisdictionPath: [1, 10],
    });
    assert.equal(g.primaryRegion(tags, [1, 10])?.regionId, 1001);
  });

  test('the title decides; places cited only in the body do not broaden it', () => {
    const tags = g.tag({
      title: 'Nala widening in Khairatabad',
      body: 'On the lines of the works completed in Secunderabad last year.',
      jurisdictionPath: [1, 10],
    });
    assert.equal(g.primaryRegion(tags, [1, 10])?.regionId, 1001);
  });

  test('with no place named, the jurisdiction is the primary region at lower confidence', () => {
    const primary = g.primaryRegion(
      g.tag({ title: 'Revised pay scales', jurisdictionPath: [1, 10] }),
      [1, 10],
    );
    assert.deepEqual(primary, { regionId: 10, path: [1, 10], confidence: 0.5 });
  });
});

describe('context-dependent names', () => {
  const g2 = new Gazetteer([
    { regionId: 1, path: [1], names: ['India'] },
    { regionId: 10, path: [1, 10], names: ['Telangana'] },
    { regionId: 50, path: [1, 50], names: ['Gujarat'] },
    { regionId: 100, path: [1, 10, 100], names: ['Greater Hyderabad', 'Hyderabad'] },
    { regionId: 1010, path: [1, 10, 100, 1010], names: ['Gandhinagar'], requires: 100 },
    { regionId: 1011, path: [1, 10, 100, 1011], names: ['Red Hills'], requires: 100 },
  ]);

  test('a ward name alone does not tag a document about somewhere else', () => {
    const tags = g2.tag({
      title: 'New secretariat complex inaugurated in Gandhinagar',
      jurisdictionPath: [1],
    });
    assert.deepEqual(tags, []);
  });

  test('two ward names cannot vouch for each other', () => {
    const tags = g2.tag({
      title: 'Gandhinagar and Red Hills get new bus routes',
      jurisdictionPath: [1, 50],
    });
    assert.deepEqual(tags, []);
  });

  test('the same name counts once the document names the city', () => {
    const tags = g2.tag({
      title: 'Hyderabad: Gandhinagar residents protest sewage overflow',
      jurisdictionPath: [1],
    });
    assert.ok(tags.some((t) => t.regionId === 1010));
  });

  test('or when the city issued it', () => {
    const tags = g2.tag({
      title: 'Desilting of nala at Red Hills',
      jurisdictionPath: [1, 10, 100],
    });
    assert.deepEqual(
      tags.map((t) => t.regionId),
      [1011],
    );
  });
});
