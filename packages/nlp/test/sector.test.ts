import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sectorFor } from '../src/sector.ts';

describe('sector of a topic', () => {
  test('titles land on the budget head a comment about the same thing would', () => {
    assert.equal(
      sectorFor('G.O.Ms.No.145: storm water drains in Greater Hyderabad'),
      'water_sanitation',
    );
    assert.equal(sectorFor('Upgradation of Osmania General Hospital'), 'health');
    assert.equal(sectorFor('Rythu Bharosa: investment support for farmers'), 'agriculture');
    assert.equal(sectorFor('Recruitment of 1,200 Group-IV posts by TSPSC'), 'labour_employment');
    assert.equal(sectorFor('Construction of Uppal flyover'), 'infrastructure');
    assert.equal(sectorFor('हर घर जल योजना'), 'water_sanitation', 'Hindi, too');
  });

  test('nothing is forced: no match, or a need no budget head answers, is null', () => {
    assert.equal(
      sectorFor('Jal Jeevan Mission extension'),
      null,
      'a scheme name alone says nothing',
    );
    assert.equal(sectorFor('Anti-corruption bureau report'), null);
    assert.equal(sectorFor(''), null);
  });
});
