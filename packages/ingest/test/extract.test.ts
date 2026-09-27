import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAmounts,
  extractClosingDate,
  extractDepartment,
  extractGazetteNumbers,
  extractGoNumbers,
  extractVacancies,
  parseIndianDate,
  parseIndianNumber,
} from '../src/extract.ts';

describe('GO numbers', () => {
  test('parses the many ways Telangana and AP write them', () => {
    for (const form of [
      'G.O.Ms.No.45',
      'G.O.MS.No. 45',
      'G.O. Ms. No. 45',
      'GO Ms No 45',
      'G.O.Ms.No:45',
    ]) {
      assert.deepEqual(
        extractGoNumbers(`Orders issued vide ${form} dated 12.03.2026`),
        [{ type: 'Ms', number: 45, canonical: 'G.O.Ms.No.45' }],
        form,
      );
    }
  });

  test('distinguishes routine orders from policy orders', () => {
    const [go] = extractGoNumbers('G.O.Rt.No.1234 Transfers and postings');
    assert.equal(go?.type, 'Rt');
    assert.equal(go?.canonical, 'G.O.Rt.No.1234');
  });

  test('deduplicates a GO cited twice', () => {
    assert.equal(extractGoNumbers('G.O.Ms.No.45 … as per G.O.Ms.No. 45').length, 1);
  });

  test('parses central gazette numbers', () => {
    assert.deepEqual(extractGazetteNumbers('Notification S.O. 1234(E) and G.S.R. 567 (E)'), [
      'S.O. 1234(E)',
      'G.S.R. 567(E)',
    ]);
  });
});

describe('Indian numbers and amounts', () => {
  test('lakh-grouped and thousand-grouped numbers parse alike', () => {
    assert.equal(parseIndianNumber('1,23,456'), 123456);
    assert.equal(parseIndianNumber('123,456'), 123456);
    assert.equal(parseIndianNumber('abc'), null);
  });

  test('crore, lakh and lakh crore scale correctly', () => {
    const [a, b, c, d] = extractAmounts(
      'Rs. 1,250 crore for drains, ₹45 lakh for parks, ₹1.2 lakh crore budget, INR 300 cr',
    );
    assert.equal(a?.rupees, 12_500_000_000);
    assert.equal(b?.rupees, 4_500_000);
    assert.equal(c?.rupees, 1_200_000_000_000);
    assert.equal(d?.rupees, 3_000_000_000);
  });

  test('a plain rupee figure is taken as rupees', () => {
    assert.equal(extractAmounts('Rs.12,34,567 sanctioned')[0]?.rupees, 1_234_567);
  });

  test('Hindi and Telugu units', () => {
    assert.equal(extractAmounts('रु. 500 करोड़ स्वीकृत')[0]?.rupees, 5_000_000_000);
    assert.equal(extractAmounts('రూ.200 కోట్లు మంజూరు')[0]?.rupees, 2_000_000_000);
  });
});

describe('vacancies', () => {
  test('reads the common English forms', () => {
    assert.equal(extractVacancies('Recruitment of 1,234 posts of Junior Assistant'), 1234);
    assert.equal(extractVacancies('Total Vacancies: 450'), 450);
    assert.equal(extractVacancies('No. of Posts - 12'), 12);
    assert.equal(extractVacancies('Group-IV Services (8,180 Posts)'), 8180);
  });

  test('reads Hindi and Telugu', () => {
    assert.equal(extractVacancies('कांस्टेबल के 4500 पदों पर भर्ती'), 4500);
    assert.equal(extractVacancies('గ్రూప్-2 లో 783 పోస్టుల భర్తీకి నోటిఫికేషన్'), 783);
  });

  test('takes the total, not a category row', () => {
    assert.equal(
      extractVacancies('Total Posts: 1,200. General 486 posts, OBC 324 posts, SC 180 posts'),
      1200,
    );
  });

  test('a year is not a vacancy count', () => {
    assert.equal(extractVacancies('Notification for 2026 posts to be announced'), null);
  });

  test('no count is null, not zero', () => {
    assert.equal(extractVacancies('Revised syllabus for the examination'), null);
  });
});

describe('dates', () => {
  test('numeric dates are DAY-first, as Indian documents write them', () => {
    assert.equal(parseIndianDate('12.03.2026'), '2026-03-12');
    assert.equal(parseIndianDate('05-11-2026'), '2026-11-05', 'must not be read as May 11');
    assert.equal(parseIndianDate('25/12/26'), '2026-12-25');
  });

  test('written-out and ISO forms', () => {
    assert.equal(parseIndianDate('12th March, 2026'), '2026-03-12');
    assert.equal(parseIndianDate('March 12, 2026'), '2026-03-12');
    assert.equal(parseIndianDate('2026-03-12'), '2026-03-12');
    assert.equal(parseIndianDate('Thu, 12 Mar 2026 10:00:00 +0530'), '2026-03-12');
  });

  test('an impossible date is rejected, not rolled over', () => {
    assert.equal(parseIndianDate('31.02.2026'), null);
  });

  test('finds the closing date of an application window', () => {
    assert.equal(
      extractClosingDate('Online applications from 01.10.2026. Last date: 15-10-2026'),
      '2026-10-15',
    );
    assert.equal(extractClosingDate('Apply before 30th November, 2026'), '2026-11-30');
    assert.equal(extractClosingDate('No deadline mentioned'), null);
  });
});

describe('departments', () => {
  test('expands secretariat abbreviations', () => {
    assert.equal(
      extractDepartment('G.O.Ms.No.45, MA&UD (Plg.I) Department'),
      'Municipal Administration & Urban Development',
    );
    assert.equal(extractDepartment('I & CAD Department'), 'Irrigation & Command Area Development');
    assert.equal(extractDepartment('Nothing here'), null);
  });
});

describe('markup', () => {
  test('entities are decoded once, after tags are gone', async () => {
    const { stripTags, decodeEntities } = await import('../src/index.ts');
    assert.equal(stripTags('<td>MA&amp;UD</td>'), 'MA&UD');
    assert.equal(
      stripTags('Rs.&nbsp;1,250&nbsp;crore &#8377;5 &#x20B9;6'),
      'Rs. 1,250 crore ₹5 ₹6',
    );
    // Escaped markup in a title stays text; it is not turned back into a tag.
    assert.equal(stripTags('a &lt;b&gt; c'), 'a <b> c');
    assert.equal(decodeEntities('&amp;lt;'), '&lt;');
    assert.equal(decodeEntities('&bogus; &#0; &#xD800;'), '&bogus; &#0; &#xD800;');
  });
});

describe('vacancies, more forms', () => {
  test('"Total Vacancies 85" without a separator', async () => {
    const { extractVacancies } = await import('../src/index.ts');
    assert.equal(
      extractVacancies('Combined Geo-Scientist Examination — Notification: Total Vacancies 85'),
      85,
    );
    assert.equal(
      extractVacancies('Walk-in for posts 3 years experience required'),
      null,
      'no separator, no "total": not a count',
    );
  });
});

describe('closing dates, more forms', () => {
  test('"apply online by" and "on or before"', async () => {
    const { extractClosingDate } = await import('../src/index.ts');
    assert.equal(extractClosingDate('232 vacancies; apply online by 14-10-2026'), '2026-10-14');
    assert.equal(
      extractClosingDate('Applications to reach on or before 5th November, 2026'),
      '2026-11-05',
    );
  });
});
