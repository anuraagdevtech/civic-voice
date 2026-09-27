import { XMLParser } from 'fast-xml-parser';

/**
 * RSS 2.0 and Atom. Feeds are the preferred source wherever one exists (PIB, RBI, most newspapers):
 * a standard format does not break when a site is redesigned, which an HTML scraper does.
 */
export interface FeedItem {
  title: string;
  link: string;
  published: string | null;
  summary: string | null;
  guid: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  // A feed item with one <category> and one with three must parse to the same shape.
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
  processEntities: true,
  htmlEntities: true,
});

function text(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text']).trim();
  }
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
};

/** One pass, so "&amp;lt;" becomes "&lt;" and not "<". Unknown named entities are left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function stripTags(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

export function parseFeed(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, any>;

  const rssItems: any[] = doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item ?? [];
  if (rssItems.length > 0) {
    return rssItems
      .map((item) => ({
        title: stripTags(text(item.title) ?? ''),
        link: (text(item.link?.[0]) ?? text(item.guid) ?? '').trim(),
        published: text(item.pubDate) ?? text(item['dc:date']),
        summary: text(item.description) ? stripTags(text(item.description) as string) : null,
        guid: text(item.guid),
      }))
      .filter((item) => item.title && item.link);
  }

  const entries: any[] = doc?.feed?.entry ?? [];
  return entries
    .map((entry) => {
      const links: any[] = entry.link ?? [];
      const alternate = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') ?? links[0];
      return {
        title: stripTags(text(entry.title) ?? ''),
        link: String(alternate?.['@href'] ?? ''),
        published: text(entry.published) ?? text(entry.updated),
        summary: text(entry.summary) ? stripTags(text(entry.summary) as string) : null,
        guid: text(entry.id),
      };
    })
    .filter((item) => item.title && item.link);
}
