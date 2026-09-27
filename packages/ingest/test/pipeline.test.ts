import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUrl,
  classifyKind,
  classifySubject,
  contentHash,
  Gazetteer,
  ingestFixture,
  ingestLive,
  isDiscussable,
  pdfText,
  PoliteFetcher,
  SOURCES,
  sourceById,
  type PipelineDeps,
  type SourceSpec,
} from '../src/index.ts';

const gazetteer = new Gazetteer([
  { regionId: 1, path: [1], names: ['India'] },
  { regionId: 10, path: [1, 10], names: ['Telangana'] },
  { regionId: 20, path: [1, 20], names: ['Andhra Pradesh'] },
  { regionId: 30, path: [1, 30], names: ['Maharashtra'] },
  { regionId: 100, path: [1, 10, 100], names: ['Greater Hyderabad', 'Hyderabad', 'GHMC'] },
  { regionId: 1001, path: [1, 10, 100, 1001], names: ['Khairatabad', 'Ward 91 Khairatabad'] },
  { regionId: 1002, path: [1, 10, 100, 1002], names: ['Ameerpet'] },
  { regionId: 1003, path: [1, 10, 100, 1003], names: ['Secunderabad'] },
]);

const ISO: Record<string, number[]> = {
  IN: [1],
  'IN-TG': [1, 10],
  'IN-AP': [1, 20],
  'IN-TG-GHMC': [1, 10, 100],
};
const deps: PipelineDeps = {
  gazetteer,
  jurisdictionPath: (iso) => ISO[iso] ?? null,
  now: () => new Date('2026-09-20T00:00:00Z'),
};
const spec = (id: string) => sourceById(id) as SourceSpec;

describe('source registry', () => {
  test('every source is complete and has a fixture', () => {
    for (const s of SOURCES) {
      assert.ok(s.id && s.name && s.url && s.fixture, s.id);
      if (s.format === 'html_list') assert.ok(s.selectors, `${s.id} has no selectors`);
      assert.ok(s.everyMinutes >= 30, `${s.id} polls more often than every 30 minutes`);
    }
  });

  test('ids are unique', () => {
    assert.equal(new Set(SOURCES.map((s) => s.id)).size, SOURCES.length);
  });

  test('every news source is link-only — news is linked, never republished', () => {
    for (const s of SOURCES.filter((x) => x.provenance === 'news'))
      assert.equal(s.linkOnly, true, s.id);
  });

  test('nothing claims to be verified that was not', () => {
    // None could be reached from the build environment; a non-null date here would be a false claim.
    assert.ok(SOURCES.every((s) => s.verified.at === null));
  });
});

describe('Telangana GO register', () => {
  test('extracts GO numbers, types, departments, amounts and places', async () => {
    const { documents } = await ingestFixture(spec('tg-goir'), deps);
    const drains = documents.find((d) => d.goNumber === 'G.O.Ms.No.145');
    assert.ok(drains, 'the storm-water GO should be ingested');
    assert.equal(drains.kind, 'government_order', 'a numbered GO is cited as a GO…');
    assert.equal(drains.subject, 'project', '…and a GO sanctioning works is also a new project');
    assert.equal(drains.goType, 'Ms');
    assert.equal(drains.department, 'Municipal Administration & Urban Development');
    assert.equal(drains.amountRupees, 12_500_000_000, '₹1,250 crore');
    assert.equal(drains.publishedOn, '2026-09-12');
    assert.equal(drains.discussable, true);
  });

  test('geo-tags a GO to every place it names, and scopes it to what they share', async () => {
    const { documents } = await ingestFixture(spec('tg-goir'), deps);
    const drains = documents.find((d) => d.goNumber === 'G.O.Ms.No.145');
    const tagged = drains?.geoTags.map((t) => t.regionId) ?? [];
    assert.ok(
      tagged.includes(1001) && tagged.includes(1003),
      `expected Khairatabad and Secunderabad, got ${tagged}`,
    );
    // Drains in two zones of the city are a Greater Hyderabad matter, not one ward's.
    assert.equal(drains?.primaryRegionId, 100);
    assert.deepEqual(drains?.primaryRegionPath, [1, 10, 100]);
  });

  test('a routine GO is indexed but not put up for discussion', async () => {
    const { documents } = await ingestFixture(spec('tg-goir'), deps);
    const transfers = documents.find((d) => d.goNumber === 'G.O.Rt.No.2311');
    assert.equal(transfers?.goType, 'Rt');
    assert.equal(transfers?.discussable, false);
  });

  test('a GO with no place named falls back to the issuing state', async () => {
    const { documents } = await ingestFixture(spec('tg-goir'), deps);
    const rythu = documents.find((d) => d.goNumber === 'G.O.Ms.No.33');
    assert.equal(rythu?.primaryRegionId, 10);
    assert.equal(rythu?.geoConfidence, 0.5, 'a fallback scope is reported as weaker evidence');
    assert.equal(rythu?.kind, 'government_order');
    assert.equal(rythu?.subject, 'scheme');
  });

  test('a row with no usable link is skipped rather than ingested broken', async () => {
    const { documents } = await ingestFixture(spec('tg-goir'), deps);
    assert.equal(
      documents.find((d) => d.goNumber === 'G.O.Ms.No.61'),
      undefined,
    );
  });
});

describe('job notifications', () => {
  test('reads vacancy counts and closing dates, and keeps them off the discussion list', async () => {
    const { documents } = await ingestFixture(spec('tg-tgpsc'), deps);
    const group2 = documents.find((d) => d.title.includes('Group-II'));
    const group4 = documents.find((d) => d.title.includes('Group-IV'));
    assert.equal(group2?.kind, 'job_notification');
    assert.equal(group2?.vacancies, 783);
    assert.equal(group4?.vacancies, 8180);
    assert.equal(group4?.closingOn, '2026-10-30');
    assert.equal(group2?.discussable, false);
  });

  test('a syllabus update on a commission site is not counted as a job', async () => {
    const { documents } = await ingestFixture(spec('tg-tgpsc'), deps);
    const syllabus = documents.find((d) => d.title.includes('syllabus'));
    assert.notEqual(syllabus?.kind, 'job_notification');
    assert.equal(syllabus?.vacancies, null);
  });

  test('a commission’s timetable and results are not job notifications', async () => {
    const { documents } = await ingestFixture(spec('upsc-whats-new'), deps);
    const jobs = documents.filter((d) => d.kind === 'job_notification');
    assert.deepEqual(
      jobs.map((d) => d.vacancies).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [85, 232],
    );
    assert.equal(jobs.find((d) => d.vacancies === 232)?.closingOn, '2026-10-14');
  });

  test('central notifications, with written-out closing dates', async () => {
    const { documents } = await ingestFixture(spec('employment-news'), deps);
    const cgl = documents.find((d) => d.title.includes('SSC Combined Graduate'));
    assert.equal(cgl?.vacancies, 17727);
    assert.equal(cgl?.closingOn, '2026-10-24');
  });
});

describe('press releases and news', () => {
  test('PIB releases: amounts and tracking-free URLs', async () => {
    const { documents } = await ingestFixture(spec('pib-releases'), deps);
    const water = documents.find((d) => d.title.includes('Jal Jeevan'));
    assert.equal(water?.amountRupees, 120_000_000_000);
    assert.ok(!water?.url.includes('utm_source'), 'tracking parameters are stripped');
    // It names three states; that makes it national, not Andhra Pradesh's because AP matched first.
    assert.equal(water?.primaryRegionId, 1);
  });

  test('a job announced in a press release is recognised as one', async () => {
    const { documents } = await ingestFixture(spec('pib-releases'), deps);
    const ssc = documents.find((d) => d.title.includes('Multi Tasking Staff'));
    assert.equal(ssc?.kind, 'job_notification');
    assert.equal(ssc?.vacancies, 8500);
    assert.equal(ssc?.closingOn, '2026-10-15');
  });

  test('news is link-only: a short snippet, never the article text', async () => {
    const { documents } = await ingestFixture(spec('thehindu-hyderabad'), deps);
    for (const doc of documents) {
      assert.equal(doc.text, null);
      assert.ok((doc.snippet?.length ?? 0) <= 281, `snippet too long: ${doc.snippet?.length}`);
      assert.equal(doc.provenance, 'news');
    }
  });

  test('news is geo-tagged to the neighbourhoods it names', async () => {
    const { documents } = await ingestFixture(spec('thehindu-hyderabad'), deps);
    const flood = documents.find((d) => d.title.includes('Waterlogging'));
    const ids = flood?.geoTags.map((t) => t.regionId) ?? [];
    assert.ok(
      ids.includes(1001) && ids.includes(1002),
      `expected Khairatabad and Ameerpet, got ${ids}`,
    );
    assert.equal(flood?.primaryRegionId, 100);
  });
});

describe('normalisation', () => {
  test('canonical URLs drop tracking parameters and fragments', () => {
    assert.equal(
      canonicalUrl('https://News.Example/a?utm_source=x&id=5&fbclid=y#top'),
      'https://news.example/a?id=5',
    );
  });

  test('the same GO at two URLs is one document', () => {
    assert.equal(
      contentHash('IN-TG', 'https://a.example/go145.pdf', 'G.O.Ms.No.145'),
      contentHash('IN-TG', 'https://b.example/mirror/go145.pdf', 'G.O.Ms.No.145'),
    );
  });

  test('the same GO number in two states is two documents', () => {
    assert.notEqual(
      contentHash('IN-TG', 'https://x/1.pdf', 'G.O.Ms.No.145'),
      contentHash('IN-AP', 'https://x/1.pdf', 'G.O.Ms.No.145'),
    );
  });

  test('kind classification', () => {
    const s = spec('tg-goir');
    assert.equal(classifyKind(s, 'e-Procurement tender for desilting of nalas', null), 'tender');
    assert.equal(classifyKind(s, 'Recruitment of 500 posts', null), 'job_notification');
    assert.equal(
      classifyKind(s, 'Guidelines under Indiramma housing scheme', 'Ms'),
      'government_order',
    );
    assert.equal(
      classifySubject('government_order', 'Guidelines under Indiramma housing scheme'),
      'scheme',
    );
    assert.equal(classifySubject('government_order', 'Revised pay scales for teachers'), null);
    // News and gazette notifications stay what they are, whatever they are about.
    assert.equal(
      classifyKind(spec('indianexpress-hyderabad'), 'Uppal flyover works to finish by March', null),
      'news',
    );
    assert.equal(classifySubject('news', 'Uppal flyover works to finish by March'), 'project');
    assert.equal(
      classifyKind(spec('egazette-extraordinary'), 'S.O. 4123(E) — widening of NH-65', null),
      'gazette_notification',
    );
    assert.equal(
      classifyKind(spec('pib-releases'), 'S.O. 88(E) published for highway widening', null),
      'gazette_notification',
    );
    assert.equal(classifySubject('job_notification', 'Recruitment for metro rail project'), null);
    assert.equal(isDiscussable('tender', null), false);
    assert.equal(isDiscussable('government_order', 'Ms'), true);
  });
});

describe('PDF text', () => {
  /** A minimal, valid, text-layer PDF, built by hand so the test needs no binary fixture. */
  function buildPdf(lines: string[]): Uint8Array {
    const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const content = `BT /F1 11 Tf 50 750 Td 14 TL ${lines.map((l) => `(${escape(l)}) '`).join(' ')} ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(pdf);
  }

  test('extracts the text layer of a GO', async () => {
    const pdf = buildPdf([
      'GOVERNMENT OF TELANGANA',
      'MA&UD Department - G.O.Ms.No.145 Dated: 12.09.2026',
      'Sanction of Rs. 1,250 crore for storm water drains in Khairatabad.',
    ]);
    const { text, pages, needsOcr } = await pdfText(pdf);
    assert.equal(pages, 1);
    assert.equal(needsOcr, false);
    assert.match(text, /G\.O\.Ms\.No\.145/);
    assert.match(text, /Khairatabad/);
  });

  test('a PDF with no text layer is flagged for OCR, not reported as blank', async () => {
    const { needsOcr } = await pdfText(buildPdf([]));
    assert.equal(needsOcr, true);
  });
});

describe('live ingestion (stubbed network)', () => {
  function stubFetcher(listingBody: string, status = 200) {
    let clock = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /private/');
      return new Response(listingBody, { status });
    }) as typeof fetch;
    return new PoliteFetcher({
      userAgent: 'CivicVoiceBot/test',
      fetch: fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  }

  test('a listing that suddenly parses to nothing is flagged as a probable redesign', async () => {
    const fetcher = stubFetcher(
      '<html><body><div class="new-layout">redesigned</div></body></html>',
    );
    const { documents, health } = await ingestLive(spec('tg-goir'), fetcher, deps, {
      previousItemCount: 3,
    });
    assert.equal(documents.length, 0);
    assert.equal(health.suspectedLayoutChange, true);
  });

  test('a quiet day on a source that never yields much is not flagged', async () => {
    const fetcher = stubFetcher('<html><body></body></html>');
    const { health } = await ingestLive(spec('tg-goir'), fetcher, deps, { previousItemCount: 0 });
    assert.equal(health.suspectedLayoutChange, false);
  });

  test('a server error is reported as the outcome, with no documents', async () => {
    const fetcher = stubFetcher('down', 502);
    const { documents, health } = await ingestLive(spec('pib-releases'), fetcher, deps);
    assert.equal(documents.length, 0);
    assert.equal(health.outcome, 'error');
  });
});
